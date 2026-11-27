# Standalone Dirlume server

Extract `dirlume-server` (`dirlume-server.exe` on Windows) on the computer that hosts the files. Choose one directory to share and a separate private state directory. The state contains a private key and an access token. Give only the service account access to the state directory, and use a separate state directory for each server address.

The default endpoint is `localhost:45179` for local use. To listen on the local network, replace the IP address and paths in this example with your own.

```sh
dirlume-server serve --root /srv/shared --state-dir /var/lib/dirlume --bind 0.0.0.0:45179 --host 192.168.1.10
```

`--host` is the IP or DNS name clients use to connect. On Windows, provide absolute Windows paths and run `dirlume-server.exe`. Allow incoming TCP on the port and network interface selected by `--bind` for clients on other computers.

Issue an invitation on the host after starting the server.

```sh
dirlume-server invite --state-dir /var/lib/dirlume
```

Share the invitation privately. It includes the address, TLS certificate, and access token for the shared folder. In Dirlume, use **Remote machine** to open the saved connection. Browse in **List** or **Tree**, press **F5** to copy files or folders to the other pane, and open or compare text files.

Shares start with read access. To grant write access to everyone who holds the invitation, add `--allow-write` to the host's `serve` command. The server still uses the service account's filesystem permissions. A writable share supports creating, editing, renaming, copying, moving, and deleting files and folders. Remove the flag and restart the server to restore read-only access. To change the address or revoke the invitation itself, stop the server and restart it with a new state directory.

## Run continuously

- **Ubuntu.** Use a systemd service under an unprivileged account. Set an absolute `ExecStart` and `Restart=on-failure`. Give the account read access to the shared folder and write access to its state directory. Grant write access to the shared folder if you run with `--allow-write`. A system service can start before login.
- **macOS.** Use a LaunchDaemon to start at boot or a LaunchAgent to start at login. In `ProgramArguments`, put the absolute executable path and each argument in its own entry. Enable `RunAtLoad` and use `KeepAlive` to restart the process.
- **Windows.** In Task Scheduler, create a task to run the executable with the `serve` arguments at startup or login. Set the task to restart after failure. To run before login, use a service account with access to both directories and configure the task to run while the account is signed out.
