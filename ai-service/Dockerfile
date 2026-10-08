FROM python:3.12-slim

WORKDIR /app

# libgomp1: OpenMP runtime LightGBM needs
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash aura
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY models ./models
COPY data ./data
# runtime state the service writes: the fine-tuned shopping model, the interest models
RUN mkdir -p /app/app/data && chown -R aura /app/app/data

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
# runs as root just long enough to chown the data directory, then drops to `aura` (see entrypoint.sh)
ENTRYPOINT ["/app/entrypoint.sh"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/ai/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
