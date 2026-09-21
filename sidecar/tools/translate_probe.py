"""Headless translate probe: start the sidecar, init translate zh->en, feed a
known Chinese sentence, print the result. Isolates the translation engine from
ASR/mic. Run with the sidecar conda python, cwd = New/sidecar."""
import asyncio
import json
import os
import subprocess
import sys

import websockets

TEXT = "你好，今天天气真不错，我们中午一起去吃火锅吧。"


async def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # New/sidecar
    proc = subprocess.Popen([sys.executable, "-m", "sokuji_sidecar"],
                            stdout=subprocess.PIPE, text=True, cwd=root)
    try:
        port = json.loads(proc.stdout.readline())["port"]
        print("sidecar port:", port, flush=True)
        async with websockets.connect(f"ws://127.0.0.1:{port}", max_size=None) as ws:
            mid = 0

            async def req(payload: dict) -> dict:
                nonlocal mid
                mid += 1
                payload = {**payload, "id": mid}
                await ws.send(json.dumps(payload))
                while True:
                    msg = await ws.recv()
                    if isinstance(msg, (bytes, bytearray)):
                        continue  # stray binary frame
                    msg = json.loads(msg)
                    if msg.get("id") == mid:
                        return msg
                    print("  push:", json.dumps(msg, ensure_ascii=False)[:160], flush=True)

            init = await req({"type": "translate_init", "sourceLang": "zh",
                              "targetLang": "en", "model": None})
            print("init:", json.dumps(init, ensure_ascii=False)[:300], flush=True)
            r = await req({"type": "translate", "text": TEXT,
                           "systemPrompt": "", "wrapTranscript": False})
            print("RESULT zh->en:", json.dumps(r, ensure_ascii=False), flush=True)
            # reverse direction, same engine session, to prove direction wiring
            init2 = await req({"type": "translate_init", "sourceLang": "en",
                               "targetLang": "zh", "model": None})
            print("init2:", json.dumps(init2, ensure_ascii=False)[:120], flush=True)
            r2 = await req({"type": "translate", "text": "Hello, how are you today?",
                            "systemPrompt": "", "wrapTranscript": False})
            print("RESULT en->zh:", json.dumps(r2, ensure_ascii=False), flush=True)
    finally:
        proc.terminate()


asyncio.run(main())
