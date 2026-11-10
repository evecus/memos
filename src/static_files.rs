use axum::{
    body::Body,
    http::{header, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use rust_embed::RustEmbed;
use serde_json::json;

/// 编译期把整个 static/ 目录打进二进制，实现单文件分发。
/// debug-embed feature 让 debug 构建也内嵌，而非运行时读磁盘。
#[derive(RustEmbed)]
#[folder = "static/"]
struct Assets;

/// SPA fallback：命中静态文件则直出，否则回退 index.html。
/// /api/ 下的未匹配路径保持 404（对齐 Go 版 ServeMux 行为）。
pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.contains("..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let candidate = if path.is_empty() { "index.html" } else { path };

    if let Some(resp) = file_response(candidate) {
        return resp;
    }
    if path.starts_with("api/") {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response();
    }
    file_response("index.html").unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

fn file_response(path: &str) -> Option<Response> {
    let file = Assets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let raw = mime.as_ref();
    let content_type = if raw.starts_with("text/") || raw.contains("javascript") || raw.contains("json")
    {
        format!("{}; charset=utf-8", raw)
    } else {
        raw.to_string()
    };

    let mut resp = Response::new(Body::from(file.data.to_vec()));
    if let Ok(value) = HeaderValue::from_str(&content_type) {
        resp.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    Some(resp)
}
