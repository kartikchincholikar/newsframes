# Project Blueprint: Comparative News Analysis Tool

This project is a web-based application designed for media analysis. It provides two primary functionalities:

1.  **Rival-Pair Comparison:** Fetches and displays headlines from two user-selected, geopolitically rival countries, filtering for news that mentions the opposing nation.
2.  **Single-Country Clustering:** Fetches all headlines from a single country and uses Natural Language Processing (NLP) to cluster them based on their similarity, helping users identify how different news sources are covering the same event.

## Directory Structure

The project is organized into a client-server architecture with a clear separation between the backend logic, frontend interface, and data sources.

headline-fetching/
│
├── rss_feeds/ # Directory for storing RSS feed URLs as CSV files.
│ ├── Armenia.csv
│ ├── China.csv
│ └── ... (one .csv file per country)
│
├── public/ # Contains all static frontend files served to the user.
│ ├── index.html
│ ├── style.css
│ └── script.js
│
├── server.js # The Node.js backend server.
└── README.md # This project blueprint file.