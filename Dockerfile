# Official Playwright image: Chromium + all system deps preinstalled.
# Tag must match the playwright version in requirements.txt (1.45.0).
FROM mcr.microsoft.com/playwright/python:v1.45.0-jammy

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Render injects PORT; default to 10000 for local docker runs.
ENV PORT=10000
CMD gunicorn app:app --bind 0.0.0.0:$PORT --timeout 180 --workers 1 --threads 4
