use std::env;
use std::fs::{self, OpenOptions};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn main() {
    let mut args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        usage();
        return;
    }

    if args[0] == "doctor" {
        doctor();
        return;
    }

    let list_formats = args[0] == "-F" || args[0] == "--formats" || args[0] == "formats";
    if list_formats {
        args.remove(0);
    }

    if args.is_empty() {
        usage();
        std::process::exit(2);
    }

    let url = args.remove(0);
    let out_dir = args.first().cloned().unwrap_or_else(|| ".".to_string());

    let is_youtube = url.contains("youtube.com") || url.contains("youtu.be");
    let is_soundcloud = url.contains("soundcloud.com");

    let status = if is_youtube {
        if let Err(err) = ensure_pot_provider() {
            eprintln!("warning: could not start PO-token provider: {err}");
        }
        run_youtube(&url, &out_dir, list_formats)
    } else if is_soundcloud {
        run_soundcloud(&url, &out_dir, list_formats)
    } else {
        run_generic(&url, &out_dir, list_formats)
    };

    match status {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("dl: {err}");
            std::process::exit(1);
        }
    }
}

fn usage() {
    eprintln!(
        "usage:
  dl URL [OUT_DIR]          download best available audio
  dl -F URL                 list formats
  dl doctor                 show setup status

YouTube Music:
  uses PO-token provider + EJS + web_music client
  prefers 774/141/251/140/bestaudio
  reads cookies from %YTDLP_COOKIES% or %USERPROFILE%\\yt-cookies.txt"
    );
}

fn home() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn cookie_path() -> Option<PathBuf> {
    if let Some(path) = env::var_os("YTDLP_COOKIES").map(PathBuf::from) {
        if path.exists() {
            return Some(path);
        }
    }

    let path = home().join("yt-cookies.txt");
    if path.exists() {
        return Some(path);
    }

    None
}

fn ensure_pot_provider() -> Result<(), String> {
    if TcpStream::connect(("127.0.0.1", 4416)).is_ok() || TcpStream::connect(("::1", 4416)).is_ok() {
        return Ok(());
    }

    let server_dir = home().join("bgutil-ytdlp-pot-provider").join("server");
    let main_js = server_dir.join("build").join("main.js");
    if !main_js.exists() {
        return Err(format!("missing {}", main_js.display()));
    }

    let log_dir = home().join("bgutil-ytdlp-pot-provider").join("logs");
    fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;

    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("provider.out.log"))
        .map_err(|e| e.to_string())?;
    let err = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("provider.err.log"))
        .map_err(|e| e.to_string())?;

    let mut cmd = Command::new("node");
    cmd.arg("build/main.js")
        .current_dir(server_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.spawn().map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_secs(2));
    Ok(())
}

fn run_youtube(url: &str, out_dir: &str, list_formats: bool) -> Result<i32, String> {
    let mut args = vec![
        "--js-runtimes".to_string(),
        "node".to_string(),
        "--extractor-args".to_string(),
        "youtube:player_client=web_music;youtubepot-bgutilhttp:base_url=http://localhost:4416".to_string(),
    ];

    if let Some(path) = cookie_path() {
        args.push("--cookies".to_string());
        args.push(path.to_string_lossy().to_string());
    }

    if list_formats {
        args.push("-F".to_string());
    } else {
        args.extend([
            "--format".to_string(),
            "774/141/251/140/bestaudio".to_string(),
            "--no-playlist".to_string(),
            "--continue".to_string(),
            "--embed-metadata".to_string(),
            "--output".to_string(),
            output_template(out_dir),
        ]);
    }

    args.push(url.to_string());
    run("yt-dlp", &args)
}

fn run_soundcloud(url: &str, out_dir: &str, list_formats: bool) -> Result<i32, String> {
    let mut args = Vec::new();

    if let Ok(token) = env::var("SOUNDCLOUD_OAUTH_TOKEN") {
        if !token.trim().is_empty() {
            args.extend(["--username".to_string(), "oauth".to_string(), "--password".to_string(), token]);
        }
    }

    if let Ok(proxy) = env::var("SOUNDCLOUD_PROXY_URL") {
        if !proxy.trim().is_empty() {
            args.extend(["--proxy".to_string(), proxy]);
        }
    }

    if list_formats {
        args.push("-F".to_string());
    } else {
        args.extend([
            "--format".to_string(),
            "http_mp3_1_0/hls_mp3_1_0/bestaudio".to_string(),
            "--no-playlist".to_string(),
            "--continue".to_string(),
            "--embed-metadata".to_string(),
            "--output".to_string(),
            output_template(out_dir),
        ]);
    }

    args.push(url.to_string());
    run("yt-dlp", &args)
}

fn run_generic(url: &str, out_dir: &str, list_formats: bool) -> Result<i32, String> {
    let mut args = Vec::new();
    if list_formats {
        args.push("-F".to_string());
    } else {
        args.extend([
            "--format".to_string(),
            "bestaudio/best".to_string(),
            "--no-playlist".to_string(),
            "--continue".to_string(),
            "--embed-metadata".to_string(),
            "--output".to_string(),
            output_template(out_dir),
        ]);
    }
    args.push(url.to_string());
    run("yt-dlp", &args)
}

fn output_template(out_dir: &str) -> String {
    Path::new(out_dir)
        .join("%(artist,uploader)s - %(title)s.%(ext)s")
        .to_string_lossy()
        .to_string()
}

fn run(program: &str, args: &[String]) -> Result<i32, String> {
    let status = Command::new(program)
        .args(args)
        .status()
        .map_err(|e| format!("failed to run {program}: {e}"))?;

    Ok(status.code().unwrap_or(1))
}

fn doctor() {
    println!("yt-dlp: {}", command_exists("yt-dlp"));
    println!("node: {}", command_exists("node"));
    println!(
        "pot_provider_repo: {}",
        home()
            .join("bgutil-ytdlp-pot-provider")
            .join("server")
            .join("build")
            .join("main.js")
            .exists()
    );
    println!(
        "pot_provider_port: {}",
        TcpStream::connect(("127.0.0.1", 4416)).is_ok() || TcpStream::connect(("::1", 4416)).is_ok()
    );
    match cookie_path() {
        Some(path) => println!("cookies: {}", path.display()),
        None => println!("cookies: not found (expected %YTDLP_COOKIES% or %USERPROFILE%\\yt-cookies.txt)"),
    }
}

fn command_exists(name: &str) -> bool {
    Command::new(name)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}
