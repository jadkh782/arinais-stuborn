# The notes tab's reading server: GLM-OCR behind llama.cpp's OpenAI-compatible server, on a free
# Hugging Face CPU Space. Phones use it because a phone tab can't hold the 800 MB on-device model.
FROM ghcr.io/ggml-org/llama.cpp:server-v0.5.0

# Spaces run the container as user 1000; keep the downloaded model somewhere writable
ENV LLAMA_CACHE=/tmp/llama-cache

EXPOSE 7860

# -hf fetches the Q8_0 model and its vision projector (~1.4 GB) on start-up
CMD ["-hf", "ggml-org/GLM-OCR-GGUF:Q8_0", "--host", "0.0.0.0", "--port", "7860", "--ctx-size", "8192", "--parallel", "1", "--threads", "2", "--no-webui"]
