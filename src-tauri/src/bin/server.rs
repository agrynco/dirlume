use std::{net::SocketAddr, path::PathBuf};

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    version = dirlume_lib::BUILD_VERSION,
    about = "Share a folder with Dirlume desktop clients over TLS"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the server without the desktop application.
    Serve {
        #[arg(long)]
        root: PathBuf,
        #[arg(long)]
        state_dir: PathBuf,
        #[arg(long, default_value = "127.0.0.1:45179")]
        bind: SocketAddr,
        #[arg(long, default_value = "localhost")]
        host: String,
        /// Allow holders of this share's private invitation to change files in the shared folder.
        #[arg(long)]
        allow_write: bool,
    },
    /// Print the private invitation for a server already initialized by serve.
    Invite {
        #[arg(long)]
        state_dir: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match Cli::parse().command {
        Command::Serve {
            root,
            state_dir,
            bind,
            host,
            allow_write,
        } => {
            dirlume_lib::server::serve(
                &root,
                &std::path::absolute(state_dir)?,
                bind,
                &host,
                allow_write,
            )
            .await
        }
        Command::Invite { state_dir } => {
            println!("{}", dirlume_lib::server::invitation(&state_dir)?);
            Ok(())
        }
    }
}
