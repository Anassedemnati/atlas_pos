#!/bin/sh
# Atlas POS .deb: the data folder of a single-till machine, writable by whoever logs in to the till.
set -e
mkdir -p /var/lib/atlas-pos
chmod 0777 /var/lib/atlas-pos
exit 0
