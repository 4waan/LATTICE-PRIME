#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ "$1" != "prove" ]; then
    echo "worker accepts only the prove operation" >&2
    exit 64
fi

for required in \
    /bundle/network.ezkl \
    /bundle/pk.key \
    /bundle/kzg.srs \
    /job/input.json
do
    if [ ! -r "$required" ]; then
        echo "required worker input is unavailable" >&2
        exit 66
    fi
done

umask 077
ezkl gen-witness \
    --data @/job/input.json \
    --compiled-circuit /bundle/network.ezkl \
    --output /job/witness.json
ezkl prove \
    --witness /job/witness.json \
    --compiled-circuit /bundle/network.ezkl \
    --pk-path /bundle/pk.key \
    --proof-path /job/proof.json \
    --srs-path /bundle/kzg.srs \
    --check-mode safe
