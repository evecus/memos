use crate::error::{AppError, Result};
use crate::models::{Attachment, Memo, UserPublic};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub struct UserRecord {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub created_at: i64,
}

impl UserRecord {
    pub fn public(&self) -> UserPublic {
        UserPublic {
            id: self.id.clone(),
            username: self.username.clone(),
            display_name: self.display_name.clone(),
        }
    }
}

pub struct ListMemosOpts {
    pub archived: bool,
    pub tag: String,
    pub limit: i64,
    pub offset: i64,
}

pub struct Store {
    conn: Mutex<Connection>,
    data_dir: PathBuf,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn map_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserRecord> {
    Ok(UserRecord {
        id: row.get(0)?,
        username: row.get(1)?,
        display_name: row.get(2)?,
        password_hash: row.get(3)?,
        created_at: row.get(4)?,
    })
}

/// 与 Go 版 ExtractTags 完全一致：按空白切词、取 # 前缀、
/// 去掉首尾标点、按小写去重但保留首次出现的原始大小写。
pub fn extract_tags(content: &str) -> Vec<String> {
    const TRIM: &str = ".,;:!?()[]{}\"'";
    let mut seen: HashSet<String> = HashSet::new();
    let mut tags = Vec::new();
    for part in content.split_whitespace() {
        if !part.starts_with('#') {
            continue;
        }
        let tag = part.trim_start_matches('#');
        let tag = tag.trim_matches(|c: char| TRIM.contains(c));
        if tag.is_empty() {
            continue;
        }
        if seen.insert(tag.to_lowercase()) {
            tags.push(tag.to_string());
        }
    }
    tags
}

impl Store {
    /// 表结构与 Go 版逐字一致，因此旧的 memos.db 可以直接继续使用。
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        std::fs::create_dir_all(data_dir.join("attachments"))?;

        let conn = Connection::open(data_dir.join("memos.db"))?;
        conn.execute_batch(
            "PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS meta (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS users (
               id TEXT PRIMARY KEY,
               username TEXT NOT NULL UNIQUE,
               display_name TEXT NOT NULL DEFAULT '',
               password_hash TEXT NOT NULL,
               created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sessions (
               token TEXT PRIMARY KEY,
               user_id TEXT NOT NULL,
               expires_at INTEGER NOT NULL,
               FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
             );
             CREATE TABLE IF NOT EXISTS memos (
               id TEXT PRIMARY KEY,
               content TEXT NOT NULL,
               pinned INTEGER NOT NULL DEFAULT 0,
               archived INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS attachments (
               id TEXT PRIMARY KEY,
               filename TEXT NOT NULL,
               mime TEXT NOT NULL DEFAULT '',
               size INTEGER NOT NULL DEFAULT 0,
               memo_id TEXT,
               created_at INTEGER NOT NULL,
               FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS idx_memos_created ON memos(created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_memos_pinned ON memos(pinned DESC, created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_attachments_memo ON attachments(memo_id);",
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
            data_dir: data_dir.to_path_buf(),
        })
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|e| AppError::internal(e.to_string()))
    }

    pub fn attachments_dir(&self) -> PathBuf {
        self.data_dir.join("attachments")
    }

    pub fn attachment_path(&self, id: &str) -> PathBuf {
        self.attachments_dir().join(id)
    }

    pub fn needs_setup(&self) -> Result<bool> {
        let conn = self.conn()?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
        Ok(count == 0)
    }

    pub fn create_user(
        &self,
        username: &str,
        display_name: &str,
        password_hash: &str,
    ) -> Result<UserRecord> {
        let conn = self.conn()?;
        let user = UserRecord {
            id: new_id(),
            username: username.to_string(),
            display_name: if display_name.is_empty() {
                username.to_string()
            } else {
                display_name.to_string()
            },
            password_hash: password_hash.to_string(),
            created_at: now(),
        };
        conn.execute(
            "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&user.id, &user.username, &user.display_name, &user.password_hash, &user.created_at],
        )?;
        Ok(user)
    }

    pub fn get_user_by_username(&self, username: &str) -> Result<Option<UserRecord>> {
        let conn = self.conn()?;
        Ok(conn
            .query_row(
                "SELECT id, username, display_name, password_hash, created_at FROM users WHERE username = ?1",
                params![username],
                map_user,
            )
            .optional()?)
    }

    fn user_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<UserRecord>> {
        conn.query_row(
            "SELECT id, username, display_name, password_hash, created_at FROM users WHERE id = ?1",
            params![id],
            map_user,
        )
        .optional()
    }

    pub fn create_session(&self, user_id: &str, ttl_secs: i64) -> Result<(String, i64)> {
        let conn = self.conn()?;
        // Go 版 token 为两个 UUID 拼接，保持一致。
        let token = format!("{}{}", Uuid::new_v4(), Uuid::new_v4());
        let expires_at = now() + ttl_secs;
        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)",
            params![&token, user_id, &expires_at],
        )?;
        Ok((token, expires_at))
    }

    pub fn get_session_user(&self, token: &str) -> Result<Option<UserRecord>> {
        if token.is_empty() {
            return Ok(None);
        }
        let conn = self.conn()?;
        let row: Option<(String, i64)> = conn
            .query_row(
                "SELECT user_id, expires_at FROM sessions WHERE token = ?1",
                params![token],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((user_id, expires_at)) = row else {
            return Ok(None);
        };
        if now() > expires_at {
            conn.execute("DELETE FROM sessions WHERE token = ?1", params![token])?;
            return Ok(None);
        }
        Ok(Self::user_by_id(&conn, &user_id)?)
    }

    pub fn delete_session(&self, token: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM sessions WHERE token = ?1", params![token])?;
        Ok(())
    }

    fn attachments_by_memo(conn: &Connection, memo_id: &str) -> rusqlite::Result<Vec<Attachment>> {
        let mut stmt = conn.prepare(
            "SELECT id, filename, mime, size, COALESCE(memo_id,''), created_at
             FROM attachments WHERE memo_id = ?1 ORDER BY created_at",
        )?;
        let rows = stmt.query_map(params![memo_id], |r| {
            Ok(Attachment {
                id: r.get(0)?,
                filename: r.get(1)?,
                mime: r.get(2)?,
                size: r.get(3)?,
                memo_id: r.get(4)?,
                created_at: r.get(5)?,
                url: String::new(),
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut attachment = row?;
            attachment.url = format!("/api/attachments/{}/file", attachment.id);
            out.push(attachment);
        }
        Ok(out)
    }

    fn load_memo(conn: &Connection, id: &str) -> rusqlite::Result<Option<Memo>> {
        let row: Option<(String, String, i64, i64, i64, i64)> = conn
            .query_row(
                "SELECT id, content, pinned, archived, created_at, updated_at FROM memos WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;
        let Some((id, content, pinned, archived, created_at, updated_at)) = row else {
            return Ok(None);
        };
        let attachments = Self::attachments_by_memo(conn, &id)?;
        Ok(Some(Memo {
            tags: extract_tags(&content),
            id,
            content,
            pinned: pinned != 0,
            archived: archived != 0,
            created_at,
            updated_at,
            attachments,
        }))
    }

    pub fn get_memo(&self, id: &str) -> Result<Option<Memo>> {
        let conn = self.conn()?;
        Ok(Self::load_memo(&conn, id)?)
    }

    pub fn create_memo(&self, content: &str, pinned: bool) -> Result<Memo> {
        let conn = self.conn()?;
        let id = new_id();
        let ts = now();
        conn.execute(
            "INSERT INTO memos (id, content, pinned, archived, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?5)",
            params![&id, content, &(pinned as i64), &ts, &ts],
        )?;
        Ok(Memo {
            id,
            content: content.to_string(),
            pinned,
            archived: false,
            tags: extract_tags(content),
            created_at: ts,
            updated_at: ts,
            attachments: Vec::new(),
        })
    }

    pub fn update_memo(
        &self,
        id: &str,
        content: &str,
        pinned: Option<bool>,
        archived: Option<bool>,
    ) -> Result<Option<Memo>> {
        let conn = self.conn()?;
        let Some(mut memo) = Self::load_memo(&conn, id)? else {
            return Ok(None);
        };
        memo.content = content.to_string();
        memo.tags = extract_tags(content);
        if let Some(v) = pinned {
            memo.pinned = v;
        }
        if let Some(v) = archived {
            memo.archived = v;
        }
        memo.updated_at = now();
        conn.execute(
            "UPDATE memos SET content = ?1, pinned = ?2, archived = ?3, updated_at = ?4 WHERE id = ?5",
            params![&memo.content, &(memo.pinned as i64), &(memo.archived as i64), &memo.updated_at, id],
        )?;
        memo.attachments = Self::attachments_by_memo(&conn, id)?;
        Ok(Some(memo))
    }

    pub fn delete_memo(&self, id: &str) -> Result<()> {
        let conn = self.conn()?;
        let attachments = Self::attachments_by_memo(&conn, id)?;
        for attachment in attachments {
            let _ = std::fs::remove_file(self.attachment_path(&attachment.id));
            conn.execute(
                "DELETE FROM attachments WHERE id = ?1",
                params![&attachment.id],
            )?;
        }
        conn.execute("DELETE FROM memos WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 注意：与 Go 版保持一致，tag 过滤发生在 LIMIT/OFFSET 之后，
    /// 因此按标签筛选时单页可能少于 limit 条。
    pub fn list_memos(&self, opts: ListMemosOpts) -> Result<Vec<Memo>> {
        let conn = self.conn()?;
        let limit = if opts.limit <= 0 { 50 } else { opts.limit };
        let offset = if opts.offset < 0 { 0 } else { opts.offset };

        let rows: Vec<(String, String, i64, i64, i64, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT id, content, pinned, archived, created_at, updated_at FROM memos
                 WHERE archived = ?1
                 ORDER BY pinned DESC, created_at DESC
                 LIMIT ?2 OFFSET ?3",
            )?;
            stmt.query_map(params![&(opts.archived as i64), &limit, &offset], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut out = Vec::new();
        for (id, content, pinned, archived, created_at, updated_at) in rows {
            let tags = extract_tags(&content);
            if !opts.tag.is_empty()
                && !tags.iter().any(|t| t.eq_ignore_ascii_case(&opts.tag))
            {
                continue;
            }
            let attachments = Self::attachments_by_memo(&conn, &id)?;
            out.push(Memo {
                id,
                tags,
                content,
                pinned: pinned != 0,
                archived: archived != 0,
                created_at,
                updated_at,
                attachments,
            });
        }
        Ok(out)
    }

    pub fn create_attachment(
        &self,
        filename: &str,
        mime: &str,
        size: i64,
        data: &[u8],
    ) -> Result<Attachment> {
        let id = new_id();
        let path = self.attachment_path(&id);
        std::fs::write(&path, data)?;

        let url = format!("/api/attachments/{}/file", id);
        let attachment = Attachment {
            id,
            filename: filename.to_string(),
            mime: mime.to_string(),
            size,
            memo_id: String::new(),
            created_at: now(),
            url,
        };

        let conn = self.conn()?;
        let result = conn.execute(
            "INSERT INTO attachments (id, filename, mime, size, memo_id, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            params![&attachment.id, &attachment.filename, &attachment.mime, &attachment.size, &attachment.created_at],
        );
        if let Err(err) = result {
            let _ = std::fs::remove_file(&path);
            return Err(AppError::internal(err.to_string()));
        }
        Ok(attachment)
    }

    pub fn link_attachment(&self, attachment_id: &str, memo_id: &str) -> Result<()> {
        let conn = self.conn()?;
        let affected = conn.execute(
            "UPDATE attachments SET memo_id = ?1 WHERE id = ?2",
            params![memo_id, attachment_id],
        )?;
        if affected == 0 {
            return Err(AppError::bad_request("attachment not found"));
        }
        Ok(())
    }

    pub fn get_attachment(&self, id: &str) -> Result<Option<Attachment>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, filename, mime, size, COALESCE(memo_id,''), created_at FROM attachments WHERE id = ?1",
        )?;
        let found: Option<Attachment> = stmt
            .query_row(params![id], |r| {
                Ok(Attachment {
                    id: r.get(0)?,
                    filename: r.get(1)?,
                    mime: r.get(2)?,
                    size: r.get(3)?,
                    memo_id: r.get(4)?,
                    created_at: r.get(5)?,
                    url: String::new(),
                })
            })
            .optional()?;
        let Some(mut attachment) = found else {
            return Ok(None);
        };
        attachment.url = format!("/api/attachments/{}/file", attachment.id);
        Ok(Some(attachment))
    }

    pub fn delete_attachment(&self, id: &str) -> Result<()> {
        let _ = std::fs::remove_file(self.attachment_path(id));
        let conn = self.conn()?;
        conn.execute("DELETE FROM attachments WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::extract_tags;

    /// 这些断言逐条对应 Go 版 store.ExtractTags 的行为。
    #[test]
    fn tags_match_go_behaviour() {
        // 按空白切词、按小写去重、保留首次出现的原始大小写。
        assert_eq!(
            extract_tags("今天写了 #Rust 和 #rust 还有 #日记。"),
            vec!["Rust", "日记。"]
        );
        // 多个前导 # 一起去掉，ASCII 标点裁剪；中文标点不在裁剪集合内。
        assert_eq!(
            extract_tags("###Todo, #Done. #a! #b? #c)"),
            vec!["Todo", "Done", "a", "b", "c"]
        );
        assert_eq!(extract_tags("#Tag #tag #TAG"), vec!["Tag"]);
        assert_eq!(extract_tags("# # ### \"\""), Vec::<String>::new());
        assert_eq!(extract_tags("无标签的普通文本"), Vec::<String>::new());
    }
}
