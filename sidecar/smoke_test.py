"""LocalTalk sidecar smoke test (no Electron needed).

Boots the WS-RPC server in-process (same wiring as `python -m sokuji_sidecar`)
and exercises the RPCs the app relies on: ping, hardware_info, models_catalog,
model_status. Run from New/sidecar with the env recorded in .python-path:

    & (Get-Content .python-path) smoke_test.py
"""
import asyncio
import json
import sys

import websockets


async def main() -> int:
    from sokuji_sidecar.server import serve
    from sokuji_sidecar import tts_engine
    from sokuji_sidecar.translate_engine import TranslateEngine, register as register_translate
    from sokuji_sidecar.asr_engine import AsrEngine, register as register_asr
    from sokuji_sidecar.native_models import register as register_models
    from sokuji_sidecar.accel import register as register_accel

    state = {
        "tts_engine": tts_engine.TtsEngine(),
        "translate_engine": TranslateEngine(),
        "asr_engine": AsrEngine(),
    }
    tts_engine.register(state)
    register_translate(state)
    register_asr(state)
    register_models(state)
    register_accel(state)
    port, server = await serve(state)
    print(f"[smoke] sidecar serving on 127.0.0.1:{port}")

    counter = 0
    try:
        async with websockets.connect(f"ws://127.0.0.1:{port}", max_size=64 * 1024 * 1024) as ws:
            async def rpc(mtype: str, timeout: float = 180.0, **fields):
                nonlocal counter
                counter += 1
                mid = counter
                await ws.send(json.dumps({"type": mtype, "id": mid, **fields}))
                deadline = asyncio.get_event_loop().time() + timeout
                while True:
                    remain = deadline - asyncio.get_event_loop().time()
                    if remain <= 0:
                        raise TimeoutError(f"{mtype} timed out")
                    msg = json.loads(await asyncio.wait_for(ws.recv(), remain))
                    if msg.get("id") == mid:
                        if msg.get("type") == "error":
                            raise RuntimeError(f"{mtype} -> error: {msg.get('message')}")
                        return msg

            pong = await rpc("ping", timeout=10)
            print(f"[smoke] ping -> {pong['type']}")

            hw = await rpc("hardware_info")
            print(f"[smoke] os={hw['os']} arch={hw['arch']} cores={hw['cpuCores']} "
                  f"lane={hw.get('lane')} native={hw.get('nativeVersion')} engines={hw.get('engineVersions')}")
            for g in hw.get("gpus") or []:
                print(f"[smoke]   gpu: {g['vendor']} {g['name']} {g['vramMb']}MB")

            for kind in ("asr", "translate", "tts"):
                cards = (await rpc("models_catalog", kind=kind))["models"]
                rec = [c["id"] for c in cards if c.get("recommended")]
                print(f"[smoke] catalog {kind}: {len(cards)} cards, recommended={rec[:3]}")

            sample = (await rpc("models_catalog", kind="asr"))["models"][:5]
            st = await rpc("model_status", models=[c["id"] for c in sample])
            print(f"[smoke] model_status(sample asr): {st['statuses']}")
    finally:
        server.close()
        await server.wait_closed()

    print("[smoke] ALL OK")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
