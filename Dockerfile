FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
COPY static ./static
RUN useradd -u 1000 -m app && mkdir -p /data && chown -R app /data
USER 1000:1000
VOLUME /data
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/healthz')" || exit 1
CMD ["gunicorn", "-b", "0.0.0.0:8000", "--workers", "1", "--threads", "4", "app:app"]
