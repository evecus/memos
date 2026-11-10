use crate::{
    auth,
    error::{AppError, Result},
    models::*,
    static_files,
    store::{ListMemosOpts, Store, UserRecord},
};
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;

/// 单请求体上限：32MB 文件 + multipart 边界开销。
const MAX_BODY: usize = 32 * 1024 * 1024 + 64 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
}

pub fn router(state: AppState) -> Router {
    Router::<AppState>::new()
        .route("/api/status", get(handle_status))
        .route("/api/setup", post(handle_setup))
        .route("/api/auth/login", post(handle_login))
        .route("/api/auth/logout", post(handle_logout))
        .route("/api/auth/me", get(handle_me))
        .route("/api/memos", get(handle_list_memos).post(handle_create_memo))
        .route(
            "/api/memos/{id}",
            get(handle_get_memo)
                .patch(handle_update_memo)
                .delete(handle_delete_memo),
        )
        .route("/api/memos/{id}/attachments", post(handle_link_attachments))
        .route("/api/attachments", post(handle_upload_attachment))
        .route(
            "/api/attachments/{id}/file",
            get(handle_attachment_file),
        )
        .route("/api/attachments/{id}", axum::routing::delete(handle_delete_attachment))
        .fallback(static_files::serve)
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(state)
}

/// rusqlite 是同步的，统一丢到 blocking 线程池，避免阻塞 tokio worker。
async fn db<F, T>(state: &AppState, f: F) -> Result<T>
where
    F: FnOnce(&Store) -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || f(&store)).await?
}

async fn session_user(state: &AppState, headers: &HeaderMap) -> Result<Option<UserPublic>> {
    let token = auth::token_from_request(headers);
    let store = state.store.clone();
    let user: Option<UserRecord> =
        tokio::task::spawn_blocking(move || store.get_session_user(&token)).await??;
    Ok(user.map(|u| u.public()))
}

async fn require_user(state: &AppState, headers: &HeaderMap) -> Result<UserPublic> {
    session_user(state, headers)
        .await?
        .ok_or_else(AppError::unauthorized)
}

fn read_json<T: serde::de::DeserializeOwned>(body: &Bytes) -> Result<T> {
    serde_json::from_slice(body.as_ref()).map_err(|_| AppError::bad_request("invalid json"))
}

fn json_resp(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

fn set_cookie(resp: &mut Response, value: String) {
    if let Ok(header_value) = HeaderValue::from_str(&value) {
        resp.headers_mut().append(header::SET_COOKIE, header_value);
    }
}

fn content_disposition(filename: &str) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let clean: String = filename
        .chars()
        .filter(|c| !matches!(c, '\r' | '\n' | '\0' | '"' | '\\'))
        .collect();
    let ascii: String = clean
        .chars()
        .map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '_' })
        .collect();
    let encoded = utf8_percent_encode(&clean, NON_ALPHANUMERIC).to_string();
    format!(
        "inline; filename=\"{}\"; filename*=UTF-8''{}",
        ascii, encoded
    )
}

// ---------------------------------------------------------------- status / auth

async fn handle_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let needs = db(&state, |s| s.needs_setup()).await?;
    // Go 版此处忽略鉴权查询错误，登录态按 false 处理。
    let logged_in = session_user(&state, &headers)
        .await
        .unwrap_or(None)
        .is_some();
    Ok(Json(json!({
        "needs_setup": needs,
        "logged_in": logged_in,
        "version": "0.1.0"
    })))
}

async fn handle_setup(State(state): State<AppState>, body: Bytes) -> Result<Response> {
    let req: SetupReq = read_json(&body)?;
    let needs = db(&state, |s| s.needs_setup()).await?;
    if !needs {
        return Err(AppError::bad_request("already set up"));
    }

    let username = req.username.trim().to_string();
    if username.is_empty() || req.password.len() < 4 {
        return Err(AppError::bad_request(
            "username required and password min 4 chars",
        ));
    }

    let display_name = req.display_name;
    let password = req.password;
    let hash = tokio::task::spawn_blocking(move || auth::hash_password(&password)).await??;

    let user = db(&state, move |s| {
        s.create_user(&username, &display_name, &hash)
    })
    .await?;
    let user_id = user.id.clone();
    let public = user.public();
    let (token, _expires) = db(&state, move |s| {
        s.create_session(&user_id, auth::SESSION_TTL_SECS)
    })
    .await?;

    let mut resp = json_resp(StatusCode::OK, json!({ "user": public }));
    set_cookie(&mut resp, auth::session_cookie(&token));
    Ok(resp)
}

async fn handle_login(State(state): State<AppState>, body: Bytes) -> Result<Response> {
    let req: LoginReq = read_json(&body)?;
    let username = req.username.trim().to_string();
    let password = req.password;
    let user = db(&state, move |s| s.get_user_by_username(&username)).await?;
    let Some(user) = user else {
        return Err(AppError::new(StatusCode::UNAUTHORIZED, "invalid credentials"));
    };

    let hash = user.password_hash.clone();
    let ok = tokio::task::spawn_blocking(move || auth::check_password(&hash, &password)).await?;
    if !ok {
        return Err(AppError::new(StatusCode::UNAUTHORIZED, "invalid credentials"));
    }

    let user_id = user.id.clone();
    let public = user.public();
    let (token, _expires) = db(&state, move |s| {
        s.create_session(&user_id, auth::SESSION_TTL_SECS)
    })
    .await?;

    let mut resp = json_resp(StatusCode::OK, json!({ "user": public }));
    set_cookie(&mut resp, auth::session_cookie(&token));
    Ok(resp)
}

async fn handle_logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let token = auth::token_from_request(&headers);
    if !token.is_empty() {
        let _ = db(&state, move |s| s.delete_session(&token)).await;
    }
    let mut resp = json_resp(StatusCode::OK, json!({ "ok": "true" }));
    set_cookie(&mut resp, auth::clear_cookie());
    Ok(resp)
}

async fn handle_me(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<UserPublic>> {
    Ok(Json(require_user(&state, &headers).await?))
}

// ---------------------------------------------------------------- memos

async fn handle_list_memos(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<Value>> {
    require_user(&state, &headers).await?;

    let limit = q
        .limit
        .as_deref()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let offset = q
        .offset
        .as_deref()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let archived = matches!(q.archived.as_deref(), Some("1") | Some("true"));
    let tag = q.tag.as_deref().unwrap_or("").trim().to_string();

    let opts = ListMemosOpts {
        archived,
        tag,
        limit,
        offset,
    };
    let memos = db(&state, move |s| s.list_memos(opts)).await?;
    Ok(Json(json!({ "memos": memos })))
}

async fn handle_create_memo(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    require_user(&state, &headers).await?;
    let req: CreateMemoReq = read_json(&body)?;
    if req.content.trim().is_empty() && req.attachment_ids.is_empty() {
        return Err(AppError::bad_request("content or attachments required"));
    }

    let content = req.content;
    let pinned = req.pinned;
    let memo = db(&state, move |s| s.create_memo(&content, pinned)).await?;
    let memo_id = memo.id.clone();
    let ids = req.attachment_ids;
    let link_id = memo_id.clone();
    let _ = db(&state, move |s| {
        for aid in &ids {
            let _ = s.link_attachment(aid, &link_id);
        }
        Ok::<(), AppError>(())
    })
    .await;

    let memo = db(&state, move |s| s.get_memo(&memo_id))
        .await?
        .ok_or_else(AppError::not_found)?;
    Ok((StatusCode::CREATED, Json(memo)).into_response())
}

async fn handle_get_memo(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Memo>> {
    require_user(&state, &headers).await?;
    let memo = db(&state, move |s| s.get_memo(&id))
        .await?
        .ok_or_else(AppError::not_found)?;
    Ok(Json(memo))
}

async fn handle_update_memo(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Memo>> {
    require_user(&state, &headers).await?;
    let req: UpdateMemoReq = read_json(&body)?;

    let check_id = id.clone();
    let existing = db(&state, move |s| s.get_memo(&check_id))
        .await?
        .ok_or_else(AppError::not_found)?;

    let UpdateMemoReq {
        content,
        pinned,
        archived,
    } = req;
    let content = content.unwrap_or(existing.content);
    let memo = db(&state, move |s| s.update_memo(&id, &content, pinned, archived))
        .await?
        .ok_or_else(AppError::not_found)?;
    Ok(Json(memo))
}

async fn handle_delete_memo(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    require_user(&state, &headers).await?;
    db(&state, move |s| s.delete_memo(&id)).await?;
    Ok(Json(json!({ "ok": "true" })))
}

async fn handle_link_attachments(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Memo>> {
    require_user(&state, &headers).await?;
    let req: LinkAttachmentsReq = read_json(&body)?;

    let check_id = id.clone();
    let exists = db(&state, move |s| s.get_memo(&check_id)).await?;
    if exists.is_none() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "memo not found"));
    }

    let ids = req.attachment_ids;
    let link_id = id.clone();
    let _ = db(&state, move |s| {
        for aid in &ids {
            let _ = s.link_attachment(aid, &link_id);
        }
        Ok::<(), AppError>(())
    })
    .await;

    let memo = db(&state, move |s| s.get_memo(&id))
        .await?
        .ok_or_else(AppError::not_found)?;
    Ok(Json(memo))
}

// ---------------------------------------------------------------- attachments

async fn handle_upload_attachment(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Response> {
    require_user(&state, &headers).await?;

    let mut found: Option<(String, String, Vec<u8>)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::bad_request(e.to_string()))?
    {
        if field.name() == Some("file") {
            let filename = field.file_name().unwrap_or("upload").to_string();
            let mime = field.content_type().map(str::to_string).unwrap_or_default();
            let data = field
                .bytes()
                .await
                .map_err(|e| AppError::bad_request(e.to_string()))?
                .to_vec();
            found = Some((filename, mime, data));
            break;
        }
    }
    let (filename, mut mime, data) =
        found.ok_or_else(|| AppError::bad_request("file required"))?;

    if mime.is_empty() {
        mime = infer::get(&data)
            .map(|kind| kind.mime_type().to_string())
            .or_else(|| {
                mime_guess::from_path(&filename)
                    .first()
                    .map(|m| m.to_string())
            })
            .unwrap_or_else(|| "application/octet-stream".to_string());
    }
    let size = data.len() as i64;
    let attachment = db(&state, move |s| {
        s.create_attachment(&filename, &mime, size, &data)
    })
    .await?;
    Ok((StatusCode::CREATED, Json(attachment)).into_response())
}

async fn handle_attachment_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let lookup_id = id.clone();
    let attachment = db(&state, move |s| s.get_attachment(&lookup_id)).await?;
    let Some(attachment) = attachment else {
        return Err(AppError::not_found());
    };
    // Go 版先查附件再鉴权，保持顺序一致。
    require_user(&state, &headers).await?;

    let path = state.store.attachment_path(&attachment.id);
    let data = tokio::fs::read(path).await?;
    let mut resp = Response::new(Body::from(data));
    if let Ok(value) = HeaderValue::from_str(&attachment.mime) {
        resp.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    if let Ok(value) = HeaderValue::from_str(&content_disposition(&attachment.filename)) {
        resp.headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(resp)
}

async fn handle_delete_attachment(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    require_user(&state, &headers).await?;
    db(&state, move |s| s.delete_attachment(&id)).await?;
    Ok(Json(json!({ "ok": "true" })))
}
