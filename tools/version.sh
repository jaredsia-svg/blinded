#!/bin/sh
# Run by Render as the build command (render.yaml), at every deploy.
#
# Writes version.json: the commit this deploy was built from, which the
# footer shows and links to on GitHub, so anyone can see exactly which
# published code is the code in front of them. It cannot be committed with
# the code -- a commit cannot contain its own id -- so it is the one file the
# site serves that is not in the repository, and it is ignored by git.
#
# Render sets RENDER_GIT_COMMIT for every build. Anywhere else it is empty,
# and the footer shows nothing rather than a version it cannot vouch for.
printf '{"commit":"%s"}\n' "${RENDER_GIT_COMMIT:-}" > version.json
