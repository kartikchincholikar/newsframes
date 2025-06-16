document.addEventListener('DOMContentLoaded', () => {
    // compromise.js is available via the global `nlp` variable
    const API_BASE_URL = 'http://localhost:3000/api';

    // --- Element Selectors ---
    const countrySearchInput = document.getElementById('country-search');
    const tagContainer = document.getElementById('tag-container');
    const suggestionsBox = document.getElementById('suggestions-box');
    const fetchBtn = document.getElementById('fetch-btn');
    const mainContent = document.getElementById('main-content');
    const statusBar = document.getElementById('status-bar');
    const resultsGrid = document.getElementById('results-grid');
    const facetCloud = document.getElementById('facet-cloud');
    const manualSearchInput = document.getElementById('manual-search');
    const sortBtns = document.querySelectorAll('.sort-btn');
    const errorDisplay = document.getElementById('error-display');

    // --- Application State ---
    let appState = {
        allCountries: [],
        selectedCountries: new Set(),
        allHeadlines: [],
        activeFilters: {
            manualSearch: '',
            facets: new Set(),
        },
        currentSort: 'newest', // 'newest' or 'oldest'
        isLoading: false,
    };

    // --- State Management & Rendering ---

    function render() {
        renderTags();
        renderColumns();
        renderHeadlines();
        updateFetchBtnState();
    }

    function renderTags() {
        const existingTags = tagContainer.querySelectorAll('.tag');
        existingTags.forEach(tag => tag.remove());

        appState.selectedCountries.forEach(country => {
            const tag = document.createElement('div');
            tag.className = 'tag';
            tag.textContent = country;
            const closeBtn = document.createElement('span');
            closeBtn.className = 'tag-close';
            closeBtn.innerHTML = '×';
            closeBtn.onclick = () => {
                appState.selectedCountries.delete(country);
                render();
            };
            tag.appendChild(closeBtn);
            tagContainer.insertBefore(tag, countrySearchInput);
        });
    }

    function renderColumns() {
        resultsGrid.innerHTML = '';
        if (appState.selectedCountries.size === 0) {
            mainContent.classList.add('hidden');
            return;
        }
        mainContent.classList.remove('hidden');
        resultsGrid.style.gridTemplateColumns = `repeat(${appState.selectedCountries.size}, 1fr)`;
        appState.selectedCountries.forEach(country => {
            const column = document.createElement('div');
            column.className = 'result-column';
            column.id = `col-${country.replace(/\s+/g, '-')}`;
            column.innerHTML = `<h3>${country}</h3><div class="column-content"></div>`;
            resultsGrid.appendChild(column);
        });
    }

    function renderHeadlines() {
        let filteredHeadlines = [...appState.allHeadlines];

        // 1. Apply Sorting
        filteredHeadlines.sort((a, b) => {
            const dateA = new Date(a.pubDate);
            const dateB = new Date(b.pubDate);
            return appState.currentSort === 'newest' ? dateB - dateA : dateA - dateB;
        });

        // 2. Apply Filtering
        const manualQuery = appState.activeFilters.manualSearch.toLowerCase().trim();
        const activeFacets = Array.from(appState.activeFilters.facets);

        if (manualQuery || activeFacets.length > 0) {
            filteredHeadlines = filteredHeadlines.filter(headline => {
                const headlineText = `${headline.title} ${headline.description}`.toLowerCase();
                const matchesManual = manualQuery ? headlineText.includes(manualQuery) : true;
                const matchesFacets = activeFacets.every(facet => headlineText.includes(facet));
                return matchesManual && matchesFacets;
            });
        }
        
        // 3. Clear existing columns and render
        document.querySelectorAll('.column-content').forEach(col => col.innerHTML = '');
        filteredHeadlines.forEach(headline => {
            const colContent = document.getElementById(`col-${headline.country.replace(/\s+/g, '-')}`)?.querySelector('.column-content');
            if (colContent) {
                colContent.appendChild(createHeadlineElement(headline));
            }
        });

        // 4. Update status bar
        statusBar.textContent = `Showing ${filteredHeadlines.length} of ${appState.allHeadlines.length} headlines.`;
    }
    
    function renderFacets(facets) {
        facetCloud.innerHTML = '';
        facets.forEach(facet => {
            const tag = document.createElement('button');
            tag.className = 'facet-tag';
            tag.textContent = facet;
            tag.onclick = () => {
                if (appState.activeFilters.facets.has(facet)) {
                    appState.activeFilters.facets.delete(facet);
                    tag.classList.remove('active');
                } else {
                    appState.activeFilters.facets.add(facet);
                    tag.classList.add('active');
                }
                renderHeadlines();
            };
            facetCloud.appendChild(tag);
        });
    }

    // --- NLP & Analysis ---
    function runAnalysis() {
        statusBar.textContent = 'Analyzing keywords...';
        // Use setTimeout to allow UI to update before this heavy task
        setTimeout(() => {
            const termFrequencies = {};
            const docFrequencies = {};
            const docs = appState.allHeadlines.map(h => `${h.title} ${h.description}`);
            
            docs.forEach(doc => {
                const terms = new Set(); // Use a set to count doc frequency only once per doc
                const parsed = nlp(doc);
                // Extract Nouns, Proper Nouns (People, Places, Orgs), and Verbs
                const relevantTerms = [
                    ...parsed.nouns().out('array'),
                    ...parsed.verbs().out('array')
                ];

                relevantTerms.forEach(term => {
                    const cleanTerm = term.toLowerCase().trim();
                    if (cleanTerm.length > 2) { // Ignore very short terms
                        termFrequencies[cleanTerm] = (termFrequencies[cleanTerm] || 0) + 1;
                        terms.add(cleanTerm);
                    }
                });
                terms.forEach(term => {
                    docFrequencies[term] = (docFrequencies[term] || 0) + 1;
                });
            });

            // Calculate TF-IDF-like score for ranking
            const termScores = Object.keys(termFrequencies).map(term => {
                const tf = termFrequencies[term];
                const idf = Math.log(docs.length / (docFrequencies[term] || 1));
                return { term, score: tf * idf };
            });

            // Sort by score and take top 30 for the facet cloud
            const topFacets = termScores.sort((a, b) => b.score - a.score).slice(0, 30).map(item => item.term);
            renderFacets(topFacets);
            statusBar.textContent = `Analysis complete. Found ${topFacets.length} top keywords.`;
        }, 50);
    }


    // --- Helper Functions ---
    function createHeadlineElement(headline) {
        const item = document.createElement('div');
        item.className = 'headline-item';
        const formattedDate = new Date(headline.pubDate).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });

        item.innerHTML = `
            <a href="${headline.link}" target="_blank" rel="noopener noreferrer">${headline.title}</a>
            <span class="headline-source">${headline.source} - <span class="headline-date">${formattedDate}</span></span>
            ${headline.description ? `<p class="headline-description">${headline.description}</p>` : ''}
        `;
        return item;
    }
    
    function updateFetchBtnState() {
        fetchBtn.disabled = appState.selectedCountries.size === 0 || appState.isLoading;
    }

    // --- Event Handlers ---
    async function handleFetch() {
        if (appState.isLoading || appState.selectedCountries.size === 0) return;
        
        appState.isLoading = true;
        statusBar.textContent = 'Fetching headlines...';
        mainContent.classList.remove('hidden');
        renderColumns(); // Show columns immediately
        errorDisplay.classList.add('hidden');
        updateFetchBtnState();

        try {
            const response = await fetch(`${API_BASE_URL}/fetch-headlines`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ countries: Array.from(appState.selectedCountries) })
            });
            if (!response.ok) throw new Error(`Server returned status: ${response.status}`);
            
            const data = await response.json();
            appState.allHeadlines = data.headlines || [];
            if(data.errors && data.errors.length > 0) {
                errorDisplay.textContent = `Encountered errors: ${data.errors.join(', ')}`;
                errorDisplay.classList.remove('hidden');
            }
            
            runAnalysis();
            renderHeadlines();

        } catch (error) {
            console.error('Fetch error:', error);
            errorDisplay.textContent = `A critical error occurred: ${error.message}`;
            errorDisplay.classList.remove('hidden');
        } finally {
            appState.isLoading = false;
            updateFetchBtnState();
        }
    }

    function handleCountrySearch(e) {
        const query = e.target.value.toLowerCase();
        suggestionsBox.innerHTML = '';
        if (!query) return;

        const filtered = appState.allCountries
            .filter(c => c.toLowerCase().startsWith(query) && !appState.selectedCountries.has(c))
            .slice(0, 5);
        
        filtered.forEach(country => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.textContent = country;
            item.onclick = () => {
                appState.selectedCountries.add(country);
                countrySearchInput.value = '';
                suggestionsBox.innerHTML = '';
                render();
            };
            suggestionsBox.appendChild(item);
        });
    }
    
    // --- Initialization ---
    async function initialize() {
        try {
            const response = await fetch(`${API_BASE_URL}/countries`);
            appState.allCountries = await response.json();
        } catch (error) {
            console.error("Failed to fetch country list", error);
            alert("Could not connect to the server to get the country list.");
        }

        // Event Listeners
        fetchBtn.addEventListener('click', handleFetch);
        countrySearchInput.addEventListener('input', handleCountrySearch);
        manualSearchInput.addEventListener('input', (e) => {
            appState.activeFilters.manualSearch = e.target.value;
            renderHeadlines();
        });
        sortBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                appState.currentSort = btn.dataset.sort;
                sortBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                renderHeadlines();
            });
        });

        // Initial render
        render();
    }

    initialize();
});