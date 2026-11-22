"""A three-server loopback SSH route with stage-specific forwarding and credentials."""

import errno
from contextlib import suppress
import io
import json
import logging
import os
from pathlib import Path, PurePosixPath
import secrets
import socket
import sys
import threading

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
import paramiko


logging.getLogger("paramiko").setLevel(logging.CRITICAL)
root = Path(sys.argv[1]).resolve()
private_key = root.parent / "jump-fixture-ed25519"
passphrase = secrets.token_urlsafe(20)
private_key.write_bytes(ed25519.Ed25519PrivateKey.generate().private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
    serialization.BestAvailableEncryption(passphrase.encode()),
))
key = paramiko.Ed25519Key.from_private_key_file(str(private_key), password=passphrase)
keys = [paramiko.RSAKey.generate(2048) for _ in range(3)]
passwords = [secrets.token_urlsafe(20) for _ in keys]
names = ["127.0.0.1", "second-bastion.invalid", "destination.invalid"]
listeners = [socket.create_server(("127.0.0.1", 0)) for _ in keys]
ports = [listener.getsockname()[1] for listener in listeners]
active = [0, 0, 0]
guard = threading.Lock()


def pump(source, destination):
    try:
        while data := source.recv(32768):
            destination.sendall(data)
    except (EOFError, OSError):
        pass
    finally:
        for stream in (destination, source):
            with suppress(EOFError, OSError):
                stream.shutdown(socket.SHUT_RDWR)
            with suppress(EOFError, OSError):
                stream.close()


class Server(paramiko.ServerInterface):
    def __init__(self, stage):
        self.stage = stage
        self.forwarded = {}

    def get_allowed_auths(self, _username):
        return "publickey" if self.stage == 1 else "password"

    def check_auth_password(self, username, candidate):
        if self.stage != 1 and username == f"fixture-{self.stage}" and candidate == passwords[self.stage]:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_auth_publickey(self, username, candidate):
        if self.stage == 1 and username == "fixture-1" and candidate == key:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_channel_request(self, kind, _channel_id):
        if self.stage == 2 and kind == "session":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_direct_tcpip_request(self, channel_id, _origin, destination):
        following = self.stage + 1
        if following >= len(names) or destination != (names[following], ports[following]):
            return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        try:
            self.forwarded[channel_id] = socket.create_connection(("127.0.0.1", ports[following]), timeout=4)
            self.forwarded[channel_id].settimeout(None)
        except OSError:
            return paramiko.OPEN_FAILED_CONNECT_FAILED
        return paramiko.OPEN_SUCCEEDED

    def check_channel_pty_request(self, _channel, _term, _width, _height, _pixel_width, _pixel_height, _modes):
        return self.stage == 2

    def check_channel_exec_request(self, channel, _command):
        if self.stage != 2:
            return False

        def respond():
            try:
                channel.sendall(b"jump-shell-ready\r\n")
                while data := channel.recv(4096):
                    channel.sendall(data)
            except (EOFError, OSError):
                pass

        threading.Thread(target=respond, daemon=True).start()
        return True


class Files(paramiko.SFTPServerInterface):
    @staticmethod
    def path(path):
        parts = PurePosixPath("/" + path.lstrip("/")).parts[1:]
        if ".." in parts:
            raise PermissionError(errno.EACCES, "Path is outside the fixture.")
        return root.joinpath(*parts)

    def list_folder(self, path):
        entries = []
        try:
            for file in self.path(path).iterdir():
                entries.append(paramiko.SFTPAttributes.from_stat(file.stat(), filename=file.name))
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)
        return entries

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(self.path(path).stat())
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    lstat = stat

    def open(self, path, flags, _attributes):
        try:
            fd = os.open(self.path(path), flags | getattr(os, "O_BINARY", 0), 0o600)
            if flags & os.O_RDWR:
                mode = "r+b"
            else:
                mode = "wb" if flags & os.O_WRONLY else "rb"
            file = io.open(fd, mode=mode)
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)
        handle = paramiko.SFTPHandle(flags)
        handle.readfile = handle.writefile = file
        return handle

    def posix_rename(self, old, new):
        try:
            self.path(old).replace(self.path(new))
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)
        return paramiko.SFTP_OK

    rename = posix_rename

    def remove(self, path):
        try:
            self.path(path).unlink()
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)
        return paramiko.SFTP_OK


def handle_connection(client, stage):
    server = Server(stage)
    with guard:
        active[stage] += 1
        host_key = keys[stage]
    try:
        with paramiko.Transport(client) as transport:
            transport.add_server_key(host_key)
            if stage == 2:
                transport.set_subsystem_handler("sftp", paramiko.SFTPServer, Files)
            transport.start_server(server=server)
            while transport.is_active():
                channel = transport.accept(timeout=0.25)
                if channel is None or stage == 2:
                    continue
                next_socket = server.forwarded.pop(channel.get_id())
                threading.Thread(target=pump, args=(channel, next_socket), daemon=True).start()
                threading.Thread(target=pump, args=(next_socket, channel), daemon=True).start()
    except (EOFError, OSError, paramiko.SSHException):
        pass
    finally:
        for forwarded in server.forwarded.values():
            forwarded.close()
        with guard:
            active[stage] -= 1


def serve(listener, stage):
    while True:
        connection, _ = listener.accept()
        threading.Thread(target=handle_connection, args=(connection, stage), daemon=True).start()


for stage, listener in enumerate(listeners):
    threading.Thread(target=serve, args=(listener, stage), daemon=True).start()

hosts = [
    dict(host=name, port=ports[index], username=f"fixture-{index}", auth={"kind": "password"}, secret=passwords[index])
    for index, name in enumerate(names)
]
hosts[1].update(auth={"kind": "privateKey", "path": str(private_key)}, secret=passphrase)
print(json.dumps({"hosts": hosts}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    if "rotate" in command:
        replacement = paramiko.RSAKey.generate(2048)
        with guard:
            keys[command["rotate"]] = replacement
    with guard:
        print(json.dumps({"active": active}), flush=True)
