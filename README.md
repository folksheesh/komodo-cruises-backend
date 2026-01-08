# Core Backend API

This repository hosts the main server application for the 12 SEAS ALLIANCE platform. It serves as the single source of truth, managing data ingestion from Google Apps Script and serving search results to the frontend.

## 🏗 Tech Stack
*   **Runtime:** Node.js (TypeScript)
*   **Database:** PostgreSQL (managed via Coolify)

## ⚡ Key Responsibilities
1.  **Data Ingestion:** Receives webhook `POST` requests from the Google Apps Script worker to update live inventory.
2.  **Data Merging:** Performs "Upsert" operations to merge static reference data with live availability.
3.  **Client Search:** Exposes public endpoints for the Frontend to query availability.
4.  **Persistence:** Manages the PostgreSQL database schema and migrations.
5.  **Payment:** Manages the Payment Api, as well as Temporary Stock Deduction after payment.


## 🚀 Deployment
This repository is configured for automated deployment via Coolify
