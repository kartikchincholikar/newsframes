const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const csv = require('csv-parser');
const RssParser = require('rss-parser');

const app = express();
const port = 3000;
const rssParser = new RssParser();
const feedsDir = path.join(__dirname, 'rss_feeds');

// Middleware
app.use(cors());
app.use(express.static('public')); // Serve static files from the 'public' directory

// --- API Endpoints ---

// Endpoint to get the list of available countries from the csv filenames
app.get('/api/countries', (req, res) => {
    fs.readdir(feedsDir, (err, files) => {
        if (err) {
            console.error("Could not list the directory.", err);
            return res.status(500).send("Server error");
        }
        // Filter for .csv files and remove the extension
        const countries = files
            .filter(file => path.extname(file).toLowerCase() === '.csv')
            .map(file => path.basename(file, '.csv'));
        res.json(countries);
    });
});

// Endpoint to fetch headlines for a pair of rival countries
app.get('/api/headlines', async (req, res) => {
    const { country1, country2 } = req.query;

    if (!country1 || !country2) {
        return res.status(400).json({ error: 'Two countries must be specified.' });
    }

    try {
        const [data1, data2] = await Promise.all([
            fetchCountryData(country1),
            fetchCountryData(country2)
        ]);

        res.json({
            [country1]: data1,
            [country2]: data2
        });

    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch headline data.' });
    }
});


// --- Helper Functions ---

// Fetches all RSS data for a single country
async function fetchCountryData(countryName) {
    const urls = await getUrlsFromCsv(countryName);
    const headlines = [];
    const errors = [];

    // Process all RSS feed URLs for the country concurrently
    const promises = urls.map(url =>
        rssParser.parseURL(url)
            .then(feed => {
                feed.items.forEach(item => {
                    if (item.title) {
                        headlines.push({ title: item.title.trim(), source: feed.title || url });
                    }
                });
            })
            .catch(err => {
                // If parsing a URL fails, record the error and continue
                console.error(`Error fetching/parsing ${url}:`, err.message);
                errors.push(`Failed to fetch or parse feed: ${url}`);
            })
    );

    await Promise.all(promises);

    return { headlines, errors };
}

// Reads a CSV file for a country and returns an array of URLs
function getUrlsFromCsv(countryName) {
    return new Promise((resolve, reject) => {
        const urls = [];
        const filePath = path.join(feedsDir, `${countryName}.csv`);

        if (!fs.existsSync(filePath)) {
            return reject(new Error(`CSV file not found for ${countryName}`));
        }

        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                if (row.url) {
                    urls.push(row.url);
                }
            })
            .on('end', () => {
                resolve(urls);
            })
            .on('error', (err) => {
                reject(err);
            });
    });
}


app.listen(port, () => {
    console.log(`Rival News Server running at http://localhost:${port}`);
});