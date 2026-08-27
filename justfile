set default-list := true

test: setup
    node --test extensions/subagent/*.test.ts
    node dev/check-frontmatter.mjs

pre-commit: test
    just test

setup:
    #!/bin/sh
    set -eu
    hook="{{justfile_directory()}}/.git/hooks/pre-commit"
    [ -f "${hook}" ] && exit 0
    cp "{{justfile_directory()}}/dev/pre-commit" "${hook}"
    echo "Installed git pre-commit hook"
