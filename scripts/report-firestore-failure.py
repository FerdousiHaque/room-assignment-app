#!/usr/bin/env python3
"""
Posts a firebase-tools deploy failure log as a GitHub commit comment.
Run-log storage (Azure Blob) isn't reachable from every environment that
might need to debug a failed deploy, but the GitHub REST API is, so this
gives a debuggable trail without depending on Actions log storage.

Reads: LOG_FILE, GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN from the
environment (all set by the calling workflow step).
"""
import json
import os
import urllib.request

log_file = os.environ.get("LOG_FILE", "/tmp/firestore-deploy.log")
with open(log_file) as f:
    log = f.read()[-5000:]

body = "### Firestore rules deploy failed\n```\n" + log + "\n```"

req = urllib.request.Request(
    f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/commits/{os.environ['GITHUB_SHA']}/comments",
    data=json.dumps({"body": body}).encode(),
    headers={
        "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(req) as resp:
    print("Posted commit comment:", resp.status)
