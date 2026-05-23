# 📖 Standard Operating Procedure (SOP): Deployment Guide

This document explains how to deploy the **Swing Trading App** on any target system, including **local development machines (Windows, macOS, Linux)**, **Docker Compose containers**, and **AWS EC2 production environments**.

---

## 🏗️ 1. Zero-Cost System Architecture Overview

Before deploying, it helps to understand the application components:
- **Frontend**: A static web interface (HTML5, Vanilla CSS, Vanilla JS, Chart.js) that runs directly in the user's browser.
- **Backend API**: A Node.js (Express) server that acts as a proxy to fetch Yahoo Finance stock statistics, calculate indicators, manage database caching, and proxy the Gemini AI chat.
- **Database (Optional)**: A PostgreSQL instance to cache market summary calculations and session records (configured for server deployments).

---

## 💻 2. Local Environment Deployment (Without Docker)

Use this method to run or develop the application directly on your local system.

### Prerequisites:
- **Node.js**: Version 18.x or 20.x installed.
- **Git**: Installed.

### Step-by-Step Setup:
1. **Clone the Repository**:
   ```bash
   git clone https://github.com/jitheeshjames96/swingtradeapp.git
   cd swingtradeapp
   ```
2. **Install Backend Dependencies**:
   ```bash
   cd server
   npm install
   ```
3. **Configure Environment Variables**:
   In the `/server` directory, create a `.env` file (or copy `.env.example`):
   ```ini
   PORT=3000
   NODE_ENV=development
   # Keep DATABASE_URL blank or comment it out to use in-memory cache fallbacks
   # DATABASE_URL=
   ```
4. **Start the Backend Node Server**:
   ```bash
   npm start
   ```
   The backend will boot and listen on `http://localhost:3000`.

5. **Launch the Frontend Web App**:
   You can run a simple static server in the root of the project:
   ```bash
   cd ..
   npx serve .
   ```
   Alternatively, you can double-click and open the `index.html` file directly in any modern browser.

6. **Connect Frontend to Backend**:
   - Open the app in your browser (e.g. `http://localhost:5000` or file path).
   - Click the **⚙️ AI Settings** gear icon in the top-right header.
   - Set the **Production Backend URL** to `http://localhost:3000` and click **Save**.
   - Paste your **Gemini AI Key** (get one free from [Google AI Studio](https://aistudio.google.com/)) to enable the AI Chatbot.

---

## 🐳 3. Multi-Container Deployment (Using Docker Compose)

This is the fastest, cleanest, and most recommended way to run the entire stack locally or on a server, isolating the database, backend, and static server automatically.

### Prerequisites:
- **Docker** and **Docker Compose** installed on your system.

### Step-by-Step Setup:
1. **Navigate to the Root Directory**:
   Ensure you are in the repository folder containing `docker-compose.yml`.
2. **Build and Run the Containers**:
   ```bash
   docker compose up --build -d
   ```
   *What this command does:*
   - Spins up a **PostgreSQL Database** container (`swing_trading_db`) on port 5432.
   - Builds and boots the **Express Backend** container (`swing_trading_backend`) on port 3000.
   - Configures an **Nginx Frontend** container (`swing_trading_frontend`) on port 80 to serve the static frontend and reverse proxy API endpoints to the backend.

3. **Access the Application**:
   - Open your browser and go to `http://localhost/` (port 80).
   - The application is immediately configured to route `/api/*` requests through the Nginx container directly to the backend.
   - Click **⚙️ AI Settings** to add your free Gemini API key to enable "Invy" AI chats.

---

## ☁️ 4. AWS EC2 Production Deployment

Follow these instructions to host a production-ready version of the application on an AWS EC2 instance.

### Prerequisites:
- An AWS Account.
- Domain name (optional, but recommended for setting up HTTPS/SSL).

### Step 1: Launch the EC2 Instance
1. Go to the AWS console and launch an **EC2 Instance**.
2. Select **Ubuntu 22.04 LTS** as the Operating System.
3. Choose instance size (e.g., `t3.micro` or `t3.small` is more than enough).
4. Configure the **Security Group** to allow the following ports:
   - `Port 22` (SSH) — restricted to your IP.
   - `Port 80` (HTTP) — open to Anywhere.
   - `Port 443` (HTTPS) — open to Anywhere.

### Step 2: Install Docker and Git on Ubuntu
Connect to your EC2 instance via SSH:
```bash
ssh -i "your-key.pem" ubuntu@your-ec2-ip
```
Update packages and install Docker:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker ubuntu
newgrp docker

# Install Docker Compose v2
sudo apt install -y docker-compose-plugin
```

### Step 3: Clone and Launch the App
Clone your repository and spin up Docker containers:
```bash
git clone https://github.com/jitheeshjames96/swingtradeapp.git
cd swingtradeapp
docker compose up --build -d
```
The application is now live on your EC2 public IP at `http://your-ec2-ip`.

### Step 4: Configure Domain Name and HTTPS (SSL)
To configure HTTPS/SSL (required for Google Identity/SSO and secure API connections):
1. Point your domain's DNS `A Record` to your **EC2 Public IP**.
2. Install **Certbot** for Let's Encrypt:
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   ```
3. Stop the frontend Docker container so port 80 is temporarily free, or run Certbot in webroot mode:
   ```bash
   docker compose stop frontend
   ```
4. Run Certbot to generate the SSL certificate:
   ```bash
   sudo certbot certonly --standalone -d yourdomain.com -d www.yourdomain.com
   ```
5. Update your `nginx.conf` and `docker-compose.yml` to mount the certificates and listen on port 443. For production safety, it is easiest to install Nginx directly on the host system to terminate SSL, proxying requests to the Docker network.
   
   To do host-level SSL termination:
   *   Install Nginx on host: `sudo apt install -y nginx`
   *   Configure host `/etc/nginx/sites-available/default` to forward requests:
       ```nginx
       server {
           listen 80;
           server_name yourdomain.com;
           return 301 https://$host$request_uri;
       }
       server {
           listen 443 ssl;
           server_name yourdomain.com;
           ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
           ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

           location / {
               proxy_pass http://localhost:80; # Points to static frontend container
               proxy_set_header Host $host;
               proxy_set_header X-Real-IP $remote_addr;
           }
       }
       ```
   *   Restart host Nginx: `sudo systemctl restart nginx`
   *   Start the docker frontend: `docker compose start frontend`

---

## ⚡ 5. Vercel Serverless Deployment

If you prefer to host without managing servers (EC2), you can deploy the app to Vercel.

### Prerequisites:
- Vercel CLI installed (`npm install -g vercel`) or linked to your GitHub account.

### Step-by-Step Setup:
1. **GitHub Integration (Recommended)**:
   - Go to [Vercel](https://vercel.com/) and click **"Add New Project"**.
   - Connect your GitHub account and import your repository `swingtradeapp`.
   - Vercel automatically reads `vercel.json` and configures the static hosting for the frontend and redirects the `/api/*` endpoints to the serverless function in `/api/index.js`.
2. **Environment Variables**:
   Add any optional environment variables (like `DATABASE_URL` for caching summaries, or `PORT`) inside the Vercel Project settings.
3. **Manual CLI Deploy**:
   ```bash
   vercel login
   vercel --prod
   ```
