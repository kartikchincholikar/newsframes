document.addEventListener('DOMContentLoaded', () => {
    const country1Select = document.getElementById('country1');
    const country2Select = document.getElementById('country2');
    const fetchBtn = document.getElementById('fetchBtn');
    const filterToggle = document.getElementById('filterToggle');
    const loadingDiv = document.getElementById('loading');
    const results1Div = document.getElementById('results1');
    const results2Div = document.getElementById('results2');

    const API_BASE_URL = 'http://localhost:3000/api';

    // Fetch the list of countries and populate the dropdowns
    async function populateCountries() {
        try {
            const response = await fetch(`${API_BASE_URL}/countries`);
            const countries = await response.json();
            
            countries.sort(); // Sort alphabetically

            countries.forEach(country => {
                const option1 = new Option(country, country);
                const option2 = new Option(country, country);
                country1Select.add(option1);
                country2Select.add(option2);
            });

            // Set default selections
            if(countries.length > 1) {
                country1Select.value = "India";
                country2Select.value = "Pakistan";
            }

        } catch (error) {
            console.error('Failed to load country list:', error);
            results1Div.innerHTML = '<p class="error">Failed to load country list from server.</p>';
        }
    }
    
    // Main function to fetch and display headlines
    async function getHeadlines() {
        const country1 = country1Select.value;
        const country2 = country2Select.value;

        if (country1 === country2) {
            alert('Please select two different countries.');
            return;
        }

        // Reset UI
        loadingDiv.classList.remove('hidden');
        results1Div.innerHTML = '';
        results2Div.innerHTML = '';

        try {
            const response = await fetch(`${API_BASE_URL}/headlines?country1=${country1}&country2=${country2}`);
            if (!response.ok) {
                throw new Error(`Server responded with status: ${response.status}`);
            }
            const data = await response.json();

            const filterEnabled = filterToggle.checked;
            
            displayResults(results1Div, country1, data[country1], country2, filterEnabled);
            displayResults(results2Div, country2, data[country2], country1, filterEnabled);

        } catch (error) {
            console.error('Error fetching headlines:', error);
            results1Div.innerHTML = `<div class="error-log"><h3>Fetch Error</h3><p>${error.message}</p></div>`;
        } finally {
            loadingDiv.classList.add('hidden');
        }
    }

    // Function to render the results for one country
    function displayResults(container, countryName, countryData, rivalName, filterEnabled) {
        let headlinesHtml = `<h2>${countryName}</h2><ul>`;
        let displayedCount = 0;

        countryData.headlines.forEach(item => {
            const headline = item.title;
            // The filter condition:
            // - If filtering is off, always show.
            // - If filtering is on, show only if headline contains rival's name.
            if (!filterEnabled || headline.toLowerCase().includes(rivalName.toLowerCase())) {
                headlinesHtml += `<li>${headline}</li>`;
                displayedCount++;
            }
        });
        
        if (displayedCount === 0) {
            headlinesHtml += `<li>No relevant headlines found.</li>`;
        }

        headlinesHtml += '</ul>';

        // Display any errors that occurred while fetching feeds
        if (countryData.errors.length > 0) {
            headlinesHtml += '<div class="error-log"><h3>Feed Errors</h3><ul>';
            countryData.errors.forEach(err => {
                headlinesHtml += `<li>${err}</li>`;
            });
            headlinesHtml += '</ul></div>';
        }

        container.innerHTML = headlinesHtml;
    }

    // Event Listeners
    fetchBtn.addEventListener('click', getHeadlines);
    populateCountries();
});