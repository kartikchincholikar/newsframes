const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const csv = require('csv-parser');
const RssParser = require('rss-parser');
const axios = require('axios'); // Import axios

const app = express();
const port = 3000;
const rssParser = new RssParser();
const feedsDir = path.join(__dirname, 'rss_feeds');

// Middleware
app.use(cors());
app.use(express.json()); // To parse POST request bodies
app.use(express.static('public'));

// --- API Endpoints ---

// Endpoint to get the list of available countries (re-used from before)
app.get('/api/countries', (req, res) => {
    fs.readdir(feedsDir, (err, files) => {
        if (err) {
            console.error("Could not list the directory.", err);
            return res.status(500).send("Server error");
        }
        const countries = files
            .filter(file => path.extname(file).toLowerCase() === '.csv')
            .map(file => path.basename(file, '.csv'));
        res.json(countries.sort());
    });
});

// NEW UNIFIED ENDPOINT to fetch headlines for N countries
app.post('/api/fetch-headlines', async (req, res) => {
    const { countries } = req.body;

    if (!countries || !Array.isArray(countries) || countries.length === 0) {
        return res.status(400).json({ error: 'An array of country names is required.' });
    }

    let allHeadlines = [];
    let allErrors = [];

    // Process all countries concurrently
    const promises = countries.map(countryName => 
        fetchCountryData(countryName)
            .then(data => {
                allHeadlines.push(...data.headlines);
                allErrors.push(...data.errors);
            })
            .catch(err => {
                allErrors.push(`Failed to process ${countryName}: ${err.message}`);
            })
    );

    await Promise.all(promises);

    res.json({ headlines: allHeadlines, errors: allErrors });
});

// --- Helper Functions ---

// Fetches raw XML from a URL using axios to simulate a browser
async function fetchXml(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/xml, text/xml, */*'
            },
            timeout: 10000 // 10 second timeout
        });
        return response.data;
    } catch (error) {
        // Handle axios errors (like 403, 404, timeout) gracefully
        throw new Error(`Failed to fetch from ${url}. Status: ${error.response?.status || error.code}`);
    }
}

// Checks if a string contains HTML tags
function containsHtml(str) {
    if (!str) return false;
    const htmlRegex = /<[a-z][\s\S]*>/i;
    return htmlRegex.test(str);
}

// Main data fetching function for a single country
async function fetchCountryData(countryName) {
    const urls = await getUrlsFromCsv(countryName);
    const headlines = [];
    const errors = [];

    const promises = urls.map(async (url) => {
        try {
            const xml = await fetchXml(url);
            const feed = await rssParser.parseString(xml);

            const sourceName = feed.title || `Unknown Source (${url.slice(0, 30)}...)`;

            feed.items.forEach(item => {
                // Sanitize description
                const description = (item.contentSnippet && !containsHtml(item.contentSnippet)) 
                    ? item.contentSnippet.trim() 
                    : '';

                if (item.title) {
                    headlines.push({
                        country: countryName,
                        source: sourceName,
                        title: item.title.trim(),
                        link: item.link || '#',
                        description: description,
                        pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString()
                    });
                }
            });
        } catch (err) {
            console.error(`Error processing ${url}:`, err.message);
            errors.push(`Failed to process feed: ${url} (${err.message})`);
        }
    });

    await Promise.all(promises);
    return { headlines, errors };
}

// Reads URLs from a CSV file (unchanged logic)
function getUrlsFromCsv(countryName) {
    return new Promise((resolve, reject) => {
        const urls = [];
        const filePath = path.join(feedsDir, `${countryName}.csv`);
        if (!fs.existsSync(filePath)) return reject(new Error(`CSV file not found for ${countryName}`));
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => row.url && urls.push(row.url))
            .on('end', () => resolve(urls))
            .on('error', (err) => reject(err));
    });
}

app.listen(port, () => {
    console.log(`News Analysis Server running at http://localhost:${port}`);
});