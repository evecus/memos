use std::path::{Path, PathBuf};

pub struct Config {
    pub data_dir: PathBuf,
    pub addr: String,
}

const USAGE: &str = "\
simple-memos (rust)

用法:
  memos [选项]

选项:
  -d, --data-dir <目录>   数据目录（SQLite 与 attachments/），默认 <可执行文件目录>/data
  -addr, --addr <地址>    监听地址，默认 127.0.0.1:5230
  -h, --help              显示帮助

示例:
  ./memos -d /path/to/data -addr 0.0.0.0:5230
";

/// 保持与 Go 版 flag 相同的参数名，同时兼容 `-d=value` 与 `-d value`。
pub fn parse() -> Config {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut data_dir: Option<String> = None;
    let mut addr = "127.0.0.1:5230".to_string();

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let (key, inline) = match arg.split_once('=') {
            Some((k, v)) => (k, Some(v.to_string())),
            None => (arg.as_str(), None),
        };

        let take_value = |inline: Option<String>, i: &mut usize| -> Option<String> {
            if let Some(v) = inline {
                Some(v)
            } else if *i + 1 < args.len() {
                *i += 1;
                Some(args[*i].clone())
            } else {
                None
            }
        };

        match key {
            "-d" | "--data-dir" | "--d" => {
                if let Some(v) = take_value(inline, &mut i) {
                    data_dir = Some(v);
                }
            }
            "-addr" | "--addr" => {
                if let Some(v) = take_value(inline, &mut i) {
                    addr = v;
                }
            }
            "-h" | "--help" => {
                print!("{}", USAGE);
                std::process::exit(0);
            }
            _ => {}
        }
        i += 1;
    }

    let raw = data_dir.unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|dir| dir.join("data")))
            .unwrap_or_else(|| PathBuf::from("data"))
            .to_string_lossy()
            .into_owned()
    });

    let data_dir = std::path::absolute(Path::new(&raw)).unwrap_or_else(|_| PathBuf::from(&raw));
    Config { data_dir, addr }
}
