# Simple Memos (Rust)

极简单用户本地日记：Markdown 文本 + 文件/图片附件。**单二进制**，数据在本地。

后端已由 Go 重写为 Rust，前端原样保留并**编译期内嵌**进可执行文件，
运行时不需要任何 `static/` 目录，直接把二进制拷走即可运行。

## 功能

- 首次启动交互式创建管理员账号（setup）
- 日记创建 / 编辑 / 删除 / 置顶 / 归档
- `#标签` 自动解析与筛选
- 图片与文件附件上传、引用、预览/下载
- 数据目录：默认在二进制同级的 `data/`，可用 `-d` 指定

**不做：** 多用户、AI、SSO、评论、分享、多数据库。

## 运行

```bash
cargo run --release
# 浏览器打开 http://127.0.0.1:5230
```

参数：

| 参数 | 默认 | 说明 |
|------|------|------|
| `-d` / `--data-dir` | `<可执行文件目录>/data` | 数据目录（含 `memos.db` 与 `attachments/`） |
| `-addr` / `--addr` | `127.0.0.1:5230` | 监听地址 |

```bash
./memos -d /path/to/data -addr 0.0.0.0:5230
./memos --data-dir=/path/to/data --addr=0.0.0.0:5230
```

日志级别可用 `RUST_LOG` 控制，例如 `RUST_LOG=memos=debug ./memos`。

## 构建

```bash
cargo build --release           # 产物：target/release/memos
strip target/release/memos      # 可选，release profile 已自动 strip
```

`[profile.release]` 已开启 `lto`、`codegen-units=1`、`strip`、`panic=abort`，
并启用了 `rust-embed` 的 `debug-embed`，因此 **debug 构建同样内嵌前端**。

跨平台（GitHub Actions 使用 `cross` 风格的环境变量）：

```bash
rustup target add aarch64-unknown-linux-gnu
CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
  cargo build --release --target aarch64-unknown-linux-gnu
```

> `rusqlite` 使用 `bundled` feature，SQLite 由源码编译，不依赖系统库；
> 交叉编译时只需提供对应目标的 C 交叉编译器。

## 从 Go 版迁移（数据零改动）

表结构、字段名、ID 格式、会话 token 格式都与 Go 版逐字一致，
密码哈希同为 bcrypt，可直接复用旧数据：

```bash
# 旧目录结构保持不变
/path/to/data/
├── memos.db
└── attachments/
```

把旧 `data/` 整个目录放到新二进制同级，或用 `-d` 指向它即可，
**不需要任何迁移脚本**。已登录的旧会话 cookie/token 同样继续有效。

`legacy/` 目录保留了原始 Go 源码，方便对照行为与回滚。

## 前端内嵌

`static/` 下的 `index.html`、`app.css`、`app.js` 通过 `rust-embed` 在编译期
打进二进制；请求静态资源时按扩展名返回 Content-Type，未命中的路径回退到
`index.html`（SPA）。`loader.js` 与 `*.b64` 是原项目遗留文件，
`index.html` 并未引用，一并保留以免破坏任何历史引用。

## API 摘要（与 Go 版完全一致）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | `needs_setup` / `logged_in` / `version` |
| POST | `/api/setup` | 首次创建用户 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/auth/me` | 当前用户 |
| GET/POST | `/api/memos` | 列表 / 创建 |
| GET/PATCH/DELETE | `/api/memos/{id}` | 读 / 改 / 删 |
| POST | `/api/memos/{id}/attachments` | 关联附件 |
| POST | `/api/attachments` | multipart 字段 `file` |
| GET | `/api/attachments/{id}/file` | 下载（需登录） |
| DELETE | `/api/attachments/{id}` | 删除附件 |

鉴权：Cookie `memos_session`，或 `Authorization: Bearer <token>`，有效期 30 天。

## 相对 Go 版的实现差异

| 项 | Go 版 | Rust 版 |
|----|-------|---------|
| Web 框架 | net/http ServeMux | axum 0.8 |
| 数据库 | modernc.org/sqlite（纯 Go） | rusqlite（bundled SQLite C） |
| 并发模型 | 每请求 goroutine + 4 连接池 | tokio + 单连接互斥，DB 操作走 `spawn_blocking` |
| Session Cookie | `Expires` | 等价 `Max-Age`（无需日期格式化依赖） |
| 附件下载文件名 | 直接拼接 | 清洗 CRLF + RFC 5987 `filename*`，防头注入 |
| MIME 嗅探 | `http.DetectContentType` | `infer` + 扩展名兜底 |
| 请求体错误 | json.Decoder → 400 | 手动解码 → 400（避免 axum 默认 422） |

行为上刻意保留了一处 Go 版特性：**按 tag 筛选发生在 LIMIT/OFFSET 之后**，
因此带标签时单页可能少于 `limit` 条，未擅自改动以保证结果一致。

## License

MIT
