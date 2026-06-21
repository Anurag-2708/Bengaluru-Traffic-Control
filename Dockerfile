# Use a stable Python base image (Python 3.11 satisfies modern packages like Altair)
FROM python:3.11-slim

# Install system dependencies required for osmium and compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libosmium2-dev \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy the requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY . .

# Expose the backend port
EXPOSE 8000

# Start the FastAPI application using uvicorn
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
