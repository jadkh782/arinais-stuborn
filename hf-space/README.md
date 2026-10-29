---
title: arinais notes reader
emoji: 🌸
colorFrom: pink
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Reads handwritten notes and formulas (GLM-OCR, llama.cpp)
---

# arinais notes reader ♡

The reading server for the notes tab of [arinais-stuborn](https://arinais-stuborn.vercel.app/#notes).

It runs [GLM-OCR](https://huggingface.co/zai-org/GLM-OCR) (0.9B, MIT) as
[`ggml-org/GLM-OCR-GGUF`](https://huggingface.co/ggml-org/GLM-OCR-GGUF) (Q8_0) behind llama.cpp's
OpenAI-compatible server. The site sends each strip of a photo to `POST /v1/chat/completions` with the
prompt `Text Recognition:` and gets the text back, formulas as LaTeX. Nothing is stored.

- `GET /health` is `200` once the model is loaded (`503` while loading).
- The free Space sleeps after two days without use; the first request wakes it (a minute or two).

The files live in the site's repo under `hf-space/`.
