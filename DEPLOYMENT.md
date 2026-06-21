# Vercel Deployment Instructions

This guide outlines the steps to deploy the **Bengaluru Traffic Control** dashboard on Vercel using the configuration on the `deployment` branch.

## Prerequisites
- Access to the [Vercel Dashboard](https://vercel.com).
- The `deployment` branch must be merged or selected for deployment.

---

## Step-by-Step Deployment Guide

### 1. Import the Project to Vercel
1. Log in to the **Vercel Dashboard** and click **Add New** > **Project**.
2. Connect your GitHub account and import the repository: `Anurag-2708/Bengaluru-Traffic-Control`.

### 2. Configure Project Settings
In the configuration screen before deploying:
- **Framework Preset:** Select **Vite** (Vercel should automatically detect this).
- **Root Directory:** Keep the root directory `./` (do **not** change it to `frontend/`, as the root `vercel.json` coordinates the build steps).

### 3. Add Environment Variables
Add the following key under the **Environment Variables** section:
- **Key:** `VITE_API_URL`
- **Value:** The URL of your hosted FastAPI backend (e.g., `https://your-backend-api.herokuapp.com`). 
  * *Note:* If left empty, the frontend will default to sending API requests to `http://localhost:8000`.

### 4. Deploy!
Click **Deploy**. Vercel will automatically read the root [vercel.json](vercel.json) to install dependencies, build the frontend, and host it.

---

## Technical Details (Under the Hood)
The deployment uses the configurations added to the `deployment` branch:
- **`vercel.json`**: Coordinates installing dependencies inside the `frontend` sub-directory, building the production React assets, setting the output directory to `frontend/dist`, and setting up client-side SPA route rewrites to avoid `404` errors on refresh.
- **`package.json`** (root): Created to let Vercel know this is a Node.js project.
