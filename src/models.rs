use serde::{Deserialize, Serialize};

/// 对外公开的用户信息。Go 版 /api/auth/me、/api/setup、/api/auth/login
/// 都只返回这三个字段，不包含 created_at 与密码哈希。
#[derive(Debug, Clone, Serialize)]
pub struct UserPublic {
    pub id: String,
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Memo {
    pub id: String,
    pub content: String,
    pub pinned: bool,
    pub archived: bool,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Go 版为 `json:"attachments,omitempty"`，空数组时不输出该字段。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub size: i64,
    /// Go 版为 `json:"memo_id,omitempty"`，空字符串时不输出。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub memo_id: String,
    pub created_at: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
}

// 请求体：Go 版用 json.Decoder 解码，缺失字段为零值。
// `#[serde(default)]` 复现这一行为，避免缺字段时直接 4xx。

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct SetupReq {
    pub username: String,
    pub password: String,
    pub display_name: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct LoginReq {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct CreateMemoReq {
    pub content: String,
    pub pinned: bool,
    pub attachment_ids: Vec<String>,
}

/// PATCH 使用 Option 对应 Go 版的 `*string` / `*bool`：未提供则保留原值。
#[derive(Debug, Deserialize, Default)]
pub struct UpdateMemoReq {
    pub content: Option<String>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct LinkAttachmentsReq {
    pub attachment_ids: Vec<String>,
}

/// 查询参数用 String 承接，自行 parse：Go 版 strconv.Atoi 忽略解析错误（当成 0）。
#[derive(Debug, Deserialize, Default)]
pub struct ListQuery {
    pub limit: Option<String>,
    pub offset: Option<String>,
    pub archived: Option<String>,
    pub tag: Option<String>,
}
