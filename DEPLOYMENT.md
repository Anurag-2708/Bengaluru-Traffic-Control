# Bengaluru Traffic Control Deployment Guide

This guide outlines the steps to deploy the frontend on Vercel and the FastAPI backend on hosting platforms like Render or Railway.

---

## 1. Frontend Deployment (Vercel)

### Import the Project to Vercel
1. Log in to the **Vercel Dashboard** and click **Add New** > **Project**.
2. Connect your GitHub account and import the repository: `Anurag-2708/Bengaluru-Traffic-Control`.

### Configure Project Settings
In the configuration screen before deploying:
- **Framework Preset:** Select **Vite** (Vercel should automatically detect this).
- **Root Directory:** Keep the root directory `./` (do **not** change it to `frontend/`, as the root `vercel.json` coordinates the build steps).

### Add Environment Variables
Add the following key under the **Environment Variables** section:
- **Key:** `VITE_API_URL`
- **Value:** The URL of your hosted FastAPI backend (e.g., `https://bengaluru-traffic-backend.onrender.com`).
  * *Note:* If left empty, the frontend will default to sending API requests to `http://localhost:8000`.

### Deploy!
Click **Deploy**. Vercel will automatically read the root [vercel.json](vercel.json) to install dependencies, build the frontend, and host it.

---

## 2. Backend Deployment (FastAPI)

The backend runs as a Python FastAPI application. Because it requires heavy libraries (LightGBM, XGBoost, NetworkX, Pandas, Scikit-learn) and loads a large road network graph (`33.5MB`), it is best deployed on services like **Render** or **Railway**.

We have configured a `Dockerfile` to guarantee that all system and python dependencies (including `osmium` bindings) install seamlessly inside a container.

### Option A: Deploy on Render.com (Recommended & Free)
1. Sign in to the [Render Dashboard](https://dashboard.render.com).
2. Click **New** > **Web Service**.
3. Connect your Git repository and select the `deployment` branch.
4. **Choose Runtime:** Select **Docker** (Render will automatically detect the [Dockerfile](Dockerfile) in the root and build it).
5. **Configure Plan:** Choose the **Free** tier (or **Starter** for faster response times).
6. **Environment Variables:** If you are using Google Gemini for recommendation generation, add your API key:
   - **Key:** `GEMINI_API_KEY`
   - **Value:** `your-google-api-key`
7. Click **Deploy Web Service**. Once the build finishes, Render will provide a URL (e.g., `https://bengaluru-traffic-backend.onrender.com`). Use this URL as the `VITE_API_URL` in your Vercel frontend configuration.

### Option B: Deploy on Railway.app
1. Sign in to [Railway](https://railway.app).
2. Click **New Project** > **Deploy from GitHub repo**.
3. Select the repository and the `deployment` branch.
4. Railway will automatically detect the `Dockerfile` and start the containerized build.
5. In the **Variables** tab of the service, add:
   - `GEMINI_API_KEY`: `your-google-api-key` (optional, for Gemini AI suggestions)
   - `PORT`: `8000`
6. Once deployed, go to the **Settings** tab and click **Generate Domain** to get the public backend URL. Use this URL in your Vercel frontend settings.

---

## Technical Details (Under the Hood)
The deployment uses the configurations added to the `deployment` branch:
- **`vercel.json`**: Coordinates installing dependencies inside the `frontend` sub-directory, building the production React assets, setting the output directory to `frontend/dist`, and setting up client-side SPA route rewrites to avoid `404` errors on refresh.
- **`package.json`** (root): Created to let Vercel know this is a Node.js project.
- **`Dockerfile`**: Defines the container environment for the Python backend, ensuring C++ compilation libraries (`build-essential`, `libosmium2-dev`) are available for dependency installations.
- **`src/osm_parser.py`**: Updated to handle environments where the binary `osmium` library cannot be compiled, falling back gracefully if necessary.

