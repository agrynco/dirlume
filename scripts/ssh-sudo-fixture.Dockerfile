FROM ubuntu:22.04
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -qy --no-install-recommends openssh-server sudo \
    && rm -rf /var/lib/apt/lists/*

# This account and password are for the disposable loopback test server.
RUN useradd -m -s /bin/bash dirlume-fixture \
    && printf 'dirlume-fixture:fixture-login\n' | chpasswd \
    && printf 'dirlume-fixture ALL=(root) /usr/lib/openssh/sftp-server *\n' >/etc/sudoers.d/dirlume-fixture \
    && chmod 440 /etc/sudoers.d/dirlume-fixture
RUN mkdir -p /run/sshd /srv/dirlume-target/batch/protected /srv/dirlume-delete/nested \
    && chown dirlume-fixture /srv/dirlume-target /srv/dirlume-target/batch \
    && printf 'occupied\n' >/srv/dirlume-target/batch/protected/occupied.txt \
    && printf 'protected\n' >/srv/dirlume-delete/nested/protected.txt \
    && printf 'protected read\n' >/srv/dirlume-read.txt \
    && chmod 600 /srv/dirlume-read.txt

CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes -o PermitRootLogin=no"]
