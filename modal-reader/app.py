"""The notes tab's reading server: GLM-OCR behind llama.cpp's OpenAI-compatible server, on Modal (8 CPU cores;
GPUs need a payment method on the Modal account).

Phones use it because a phone tab can't hold the 800 MB on-device model. It scales to zero when idle (no
cost), runs at most one container, and the site waits for it to wake (~30-60 s). Nothing is stored.

    POST /v1/chat/completions   image + "Text Recognition:" -> text, formulas as LaTeX
    GET  /health                200 once the model is loaded (503 while loading)

Deploy: python -m modal deploy modal-reader/app.py
"""
import subprocess

import modal

REPO = "ggml-org/GLM-OCR-GGUF"
REVISION = "65a42de1148dbed2297e922b5dbc7d9b70c36578"
MODEL = "/model/GLM-OCR-Q8_0.gguf"
MMPROJ = "/model/mmproj-GLM-OCR-Q8_0.gguf"
PORT = 8080


def download():
    from huggingface_hub import hf_hub_download

    for name in (MODEL, MMPROJ):
        hf_hub_download(REPO, name.split("/")[-1], revision=REVISION, local_dir="/model")


# the model (~1.4 GB) is baked into the image, so a cold start doesn't download anything
image = (
    modal.Image.from_registry("ghcr.io/ggml-org/llama.cpp:server-v0.5.0", add_python="3.12")
    .entrypoint([])
    .pip_install("huggingface_hub==0.30.2")
    .run_function(download)
)
app = modal.App("arinais-reader")


@app.function(image=image, cpu=8.0, memory=6144, max_containers=1, scaledown_window=180, timeout=600)
@modal.concurrent(max_inputs=8)
@modal.web_server(PORT, startup_timeout=300)
def serve():
    subprocess.Popen([
        "/app/llama-server", "-m", MODEL, "--mmproj", MMPROJ,
        "--host", "0.0.0.0", "--port", str(PORT),
        "--ctx-size", "8192", "--parallel", "1", "--threads", "8", "--threads-batch", "16", "--no-webui",
    ])
