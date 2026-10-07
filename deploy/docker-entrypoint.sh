#!/bin/sh
set -eu

# Mounts can initially be root-owned. Change only these two known directories;
# application files and existing database/image files are not recursively chowned.
umask 027
for directory in /var/lib/comptoir/data /var/lib/comptoir/uploads; do
  if [ -L "$directory" ]; then
    echo "Persistent storage directories must not be symbolic links." >&2
    exit 1
  fi
  mkdir -p "$directory"
  chown node:node "$directory"
done

exec gosu node "$@"
