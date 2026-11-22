"""Loopback SFTP transport for the pane refresh browser smoke."""

import errno
import io
import json
import secrets
import socket
import stat
import sys
import threading
from pathlib import PurePosixPath

import paramiko


password = secrets.token_urlsafe(18)
key = paramiko.RSAKey.generate(2048)
folders = {"/destination": {"remote.txt": b"seed"}, "/elsewhere": {}}


class Server(paramiko.ServerInterface):
    def check_auth_password(self, username, candidate):
        return paramiko.AUTH_SUCCESSFUL if username == "fixture" and candidate == password else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, _channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


class WritableFile(paramiko.SFTPHandle):
    def __init__(self, files, name):
        super().__init__()
        self.files = files
        self.name = name
        self.writefile = io.BytesIO()

    def close(self):
        self.files[self.name] = self.writefile.getvalue()
        super().close()


class Files(paramiko.SFTPServerInterface):
    def list_folder(self, path):
        files = folders.get(path)
        if files is None:
            return paramiko.SFTPServer.convert_errno(errno.ENOENT)
        entries = []
        for name, data in files.copy().items():
            entry = paramiko.SFTPAttributes()
            entry.filename = name
            entry.st_size = len(data)
            entry.st_mode = stat.S_IFREG | 0o600
            entries.append(entry)
        return entries

    def open(self, path, _flags, _attributes):
        path = PurePosixPath(path)
        files = folders.get(str(path.parent))
        if files is None:
            return paramiko.SFTPServer.convert_errno(errno.ENOENT)
        return WritableFile(files, path.name)


def serve(listener):
    with paramiko.Transport(listener.accept()[0]) as server:
        server.add_server_key(key)
        server.set_subsystem_handler("sftp", paramiko.SFTPServer, Files)
        server.start_server(server=Server())
        server.join()


with socket.create_server(("127.0.0.1", 0)) as listener:
    threading.Thread(target=serve, args=(listener,), daemon=True).start()
    with paramiko.Transport(listener.getsockname()) as client:
        client.connect(hostkey=key, username="fixture", password=password)
        with paramiko.SFTPClient.from_transport(client) as sftp:
            print(json.dumps({"ready": True}), flush=True)
            for line in sys.stdin:
                try:
                    command, path = json.loads(line)
                    if command == "write":
                        with sftp.file(path, "wb") as file:
                            file.write(b"data")
                        result = None
                    else:
                        result = [entry.filename for entry in sftp.listdir_attr(path)]
                    print(json.dumps({"result": result}), flush=True)
                except Exception as error:
                    print(json.dumps({"error": str(error)}), flush=True)
