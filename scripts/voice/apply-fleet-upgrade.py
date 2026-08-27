#!/usr/bin/env python3
"""Apply the comprehensive prompts + org-level toolIds to the 12 MC assistants.

Per assistant: GET fresh -> replace the system message with the generated
prompt, set model.toolIds to the role's org tools, keep ONLY the inline
query KB tool (function tools move to org level) -> PATCH -> verify.
Model (gpt-5.6-luna), voice, firstMessage, server, transcriber untouched.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

KEY = os.environ["VAPI_KEY"]
BASE = "https://api.vapi.ai"
S = os.path.dirname(os.path.abspath(__file__))

TOOL_IDS = json.load(open(os.path.join(S, "fleet-prompts", "mc_org_tool_ids.json")))
MANIFEST = json.load(open(os.path.join(S, "fleet-prompts", "manifest.json")))


def api(method, path, body=None, retries=5):
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            BASE + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={
                "Authorization": f"Bearer {KEY}",
                "Content-Type": "application/json",
                "User-Agent": "curl/8.5.0",
            },
        )
        try:
            with urllib.request.urlopen(req) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            last = f"{e.code}: {detail}"
            if e.code == 429:
                time.sleep(15 * (attempt + 1))
                continue
            if e.code < 500:
                raise RuntimeError(f"{method} {path} -> {last}")
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"{method} {path} failed after {retries} tries -> {last}")


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for key, m in MANIFEST.items():
        if only and key != only:
            continue
        aid = m["assistant_id"]
        prompt = open(os.path.join(S, "fleet-prompts", os.path.basename(m["file"]))).read()
        time.sleep(1.2)
        a = api("GET", f"/assistant/{aid}")
        model = a["model"]

        # keep only the KB query tool inline
        kb_tools = [
            t for t in (model.get("tools") or [])
            if t.get("type") == "query"
        ]
        model["tools"] = kb_tools
        model["toolIds"] = [TOOL_IDS[t] for t in m["tools"]]

        msgs = model.get("messages") or []
        sys_idx = next((i for i, x in enumerate(msgs) if x.get("role") == "system"), None)
        if sys_idx is None:
            print(f"SKIP {m['name']}: no system message", file=sys.stderr)
            continue
        msgs[sys_idx] = {**msgs[sys_idx], "content": prompt}
        model["messages"] = msgs

        api("PATCH", f"/assistant/{aid}", {"model": model})
        time.sleep(1.5)
        v = api("GET", f"/assistant/{aid}")
        vm = v["model"]
        got_ids = vm.get("toolIds") or []
        got_inline = [(t.get("type"), (t.get("function") or {}).get("name")) for t in vm.get("tools") or []]
        got_sys = next(x for x in vm["messages"] if x["role"] == "system")["content"]
        ok = (
            set(got_ids) == set(TOOL_IDS[t] for t in m["tools"])
            and got_inline == [("query", "aurixa_knowledge")]
            and len(got_sys) == len(prompt)
            and vm.get("model") == "gpt-5.6-luna"
        )
        status = "applied" if ok else "VERIFY-FAILED"
        print(f"{status:14s} {m['name']:32s} prompt={len(got_sys)} toolIds={len(got_ids)} inline={got_inline} model={vm.get('model')}")


if __name__ == "__main__":
    main()
