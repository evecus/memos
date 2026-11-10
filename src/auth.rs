use crate::error::Result;
use axum::http::{header, HeaderMap};

pub const SESSION_COOKIE: &str = "memos_session";
pub const SESSION_TTL_SECS: i64 = 30 * 24 * 60 * 60;

/// bcrypt 与 Go 的 golang.org/x/crypto/bcrypt 完全互通，
/// 因此可以直接读取旧版生成的 password_hash。
pub fn hash_password(password: &str) -> Result<String> {
    Ok(bcrypt::hash(password, bcrypt::DEFAULT_COST)?)
}

pub fn check_password(hash: &str, password: &str) -> bool {
    bcrypt::verify(password, hash).unwrap_or(false)
}

/// Cookie 优先，其次 Authorization: Bearer。与 Go 版 TokenFromRequest 一致。
pub fn token_from_request(headers: &HeaderMap) -> String {
    if let Some(raw) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) {
        let prefix = format!("{}=", SESSION_COOKIE);
        for part in raw.split(';') {
            let part = part.trim();
            if let Some(value) = part.strip_prefix(&prefix) {
                if !value.is_empty() {
                    return value.to_string();
                }
            }
        }
    }
    if let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(token) = auth.strip_prefix("Bearer ") {
            if !token.is_empty() {
                return token.to_string();
            }
        }
    }
    String::new()
}

/// Go 版用 Expires，这里改用等价的 Max-Age，避免引入日期格式化依赖。
pub fn session_cookie(token: &str) -> String {
    format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
        SESSION_COOKIE, token, SESSION_TTL_SECS
    )
}

pub fn clear_cookie() -> String {
    format!(
        "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        SESSION_COOKIE
    )
}
