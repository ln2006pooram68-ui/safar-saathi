// state management
const appState = {
    destination: null, // { lat, lon, name }
    etaThresholdMinutes: 15,
    isTracking: false,
    trackingIntervalId: null,
    optimalRoutePolyline: null,
    savedTrips: JSON.parse(localStorage.getItem('savedTrips')) || [],
};

// DOM Elements
const elements = {
    tabs: document.querySelectorAll('.tab-btn'),
    tabContents: document.querySelectorAll('.tab-content'),
    destInput: document.getElementById('destination'),
    searchBtn: document.getElementById('search-dest-btn'),
    searchResults: document.getElementById('search-results'),
    minThresholdInput: document.getElementById('minutes-threshold'),
    startTrackingBtn: document.getElementById('start-tracking-btn'),
    stopTrackingBtn: document.getElementById('stop-tracking-btn'),
    statusPanel: document.getElementById('status-panel'),
    statusText: document.getElementById('current-status-text'),
    etaValue: document.getElementById('eta-value'),
    distanceValue: document.getElementById('distance-value'),
    alarmAudio: document.getElementById('alarm-audio'),
    
    // local transport & sos
    transportTab: document.getElementById('transport-tab'),
    currentLocationText: document.getElementById('current-location-text'),
    transportList: document.getElementById('transport-list'),
    refreshTransportBtn: document.getElementById('refresh-transport-btn'),
    
    // sos btns
    shareWhatsappBtn: document.getElementById('share-whatsapp-btn'),
    shareSmsBtn: document.getElementById('share-sms-btn'),
};

// initialization
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initSearch();
    initTracking();
    initSOS();
    initTransport();
    initSavedTrips();
});

// --- Tabs Logic ---
function initTabs() {
    elements.tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active from all
            elements.tabs.forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });
            elements.tabContents.forEach(c => c.classList.add('hidden'));
            
            // Add active to clicked
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
            const target = document.getElementById(tab.dataset.target);
            target.classList.remove('hidden');

            if (tab.dataset.target === 'transport-tab') {
                updateLocalTransport();
            }
        });
    });
}

// --- Search Logic (Nominatim API) ---
function initSearch() {
    elements.searchBtn.addEventListener('click', performSearch);
    elements.destInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') performSearch();
    });
}

async function performSearch() {
    const query = elements.destInput.value.trim();
    if (!query) return;

    // Append India to optimize for Indian transit
    const optimizedQuery = `${query}, India`;
    
    try {
        elements.searchBtn.textContent = '⏳';
        // search for matching locations. prioritize railway stations/bus stops via q
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(optimizedQuery)}&limit=5`);
        const data = await res.json();
        
        displaySearchResults(data);
    } catch (err) {
        console.error("Geocoding failed:", err);
        alert("Failed to search location. Please try again.");
    } finally {
        elements.searchBtn.textContent = '🔍';
    }
}

function displaySearchResults(results) {
    elements.searchResults.innerHTML = '';
    
    if (results.length === 0) {
        elements.searchResults.classList.add('hidden');
        alert("No results found in India.");
        return;
    }

    results.forEach(result => {
        const li = document.createElement('li');
        li.textContent = result.display_name;
        li.addEventListener('click', () => {
            appState.destination = {
                lat: parseFloat(result.lat),
                lon: parseFloat(result.lon),
                name: result.display_name
            };
            elements.destInput.value = result.display_name;
            elements.searchResults.classList.add('hidden');
            speakFeedback(`Destination set to: ${result.name || 'selected location'}`);
        });
        elements.searchResults.appendChild(li);
    });
    
    elements.searchResults.classList.remove('hidden');
}

// --- Tracking Logic (Geolocation + OSRM) ---
function initTracking() {
    elements.startTrackingBtn.addEventListener('click', startTracking);
    elements.stopTrackingBtn.addEventListener('click', stopTracking);
}

function startTracking() {
    if (!appState.destination) {
        alert("Please select a destination from the search results first.");
        return;
    }
    
    const threshold = parseInt(elements.minThresholdInput.value, 10);
    if (isNaN(threshold) || threshold < 1) {
        alert("Please enter a valid minutes threshold.");
        return;
    }
    
    appState.etaThresholdMinutes = threshold;
    appState.isTracking = true;
    
    // UI Updates
    elements.startTrackingBtn.classList.add('hidden');
    elements.stopTrackingBtn.classList.remove('hidden');
    elements.statusPanel.classList.remove('hidden');
    elements.statusText.textContent = "Locating your position...";
    
    speakFeedback("Tracking started. Have a safe journey.");

    // Initial check
    checkLocation();
    
    // Save Trip for future use
    saveTrip(appState.destination, threshold);
    
    // Battery optimized polling (starts at 5 mins, dynamic adjustment done in checkLocation)
    appState.trackingIntervalId = setInterval(checkLocation, 5 * 60 * 1000); 
}

function stopTracking() {
    appState.isTracking = false;
    clearInterval(appState.trackingIntervalId);
    
    elements.startTrackingBtn.classList.remove('hidden');
    elements.stopTrackingBtn.classList.add('hidden');
    elements.statusPanel.classList.add('hidden');
    
    elements.alarmAudio.pause();
    elements.alarmAudio.currentTime = 0;
    
    speakFeedback("Tracking stopped.");
}

function checkLocation() {
    if (!appState.isTracking) return;
    
    navigator.geolocation.getCurrentPosition(
        async (position) => {
            const userLat = position.coords.latitude;
            const userLon = position.coords.longitude;
            
            await calculateETA(userLat, userLon);
        },
        (error) => {
            console.error("Error getting location:", error);
            elements.statusText.textContent = "GPS Error: " + error.message;
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

async function calculateETA(userLat, userLon) {
    if (!appState.destination) return;
    
    try {
        // OSRM routing API (Coordinates are lon,lat)
        const destLon = appState.destination.lon;
        const destLat = appState.destination.lat;
        
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${userLon},${userLat};${destLon},${destLat}?overview=full&geometries=geojson`;
        
        const res = await fetch(osrmUrl);
        const data = await res.json();
        
        if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
            throw new Error("No route found");
        }
        
        const route = data.routes[0];
        const durationMins = Math.ceil(route.duration / 60); // seconds to minutes
        const distanceKm = (route.distance / 1000).toFixed(1);
        
        // --- Route Deviation Detection ---
        // If this is the first calculation, save the optimal route
        if (!appState.optimalRoutePolyline) {
            appState.optimalRoutePolyline = route.geometry.coordinates; // Array of [lon, lat]
        } else {
            // Check cross-track distance
            const deviationMeters = calculateDeviation(userLat, userLon, appState.optimalRoutePolyline);
            if (deviationMeters > 500) { // 500 meters threshold
                speakFeedback("Warning: You have deviated from the planned route.");
                elements.statusText.textContent = "Route Deviation Detected!";
                // Reset route so it recalculates a new optimal one
                appState.optimalRoutePolyline = route.geometry.coordinates;
            }
        }

        // Update UI
        if(elements.statusText.textContent !== "Route Deviation Detected!") {
             elements.statusText.textContent = "Journey actively tracked";
        }
        elements.etaValue.textContent = `${durationMins} mins`;
        elements.distanceValue.textContent = `${distanceKm} km`;
        
        // Adjust polling interval based on distance for Battery Optimization
        adjustPollingInterval(durationMins);
        
        // Check Alarm Condition
        if (durationMins <= appState.etaThresholdMinutes) {
            triggerAlarm(durationMins);
        }

    } catch (err) {
        console.error("Routing error:", err);
        elements.statusText.textContent = "Network error calculating route.";
    }
}

function adjustPollingInterval(etaMins) {
    // Dynamic polling based on ETA
    let newIntervalMs = 5 * 60 * 1000; // default 5 mins
    
    if (etaMins > 60) {
        newIntervalMs = 15 * 60 * 1000; // >1 hr away: check every 15 mins
    } else if (etaMins <= appState.etaThresholdMinutes + 5) {
        newIntervalMs = 60 * 1000; // very close: check every 1 min
    }
    
    clearInterval(appState.trackingIntervalId);
    appState.trackingIntervalId = setInterval(checkLocation, newIntervalMs);
}

function triggerAlarm(minsLeft) {
    if (!appState.isTracking) return;
    
    elements.alarmAudio.play().catch(e => console.error("Audio block:", e));
    speakFeedback(`Attention! You are approximately ${minsLeft} minutes away from your destination.`);
    
    elements.statusText.textContent = "⚠️ DESTINATION APPROACHING! ⚠️";
    elements.statusPanel.style.backgroundColor = '#fecaca'; // light red
    elements.statusPanel.style.borderColor = 'var(--danger-color)';
    
    // Stop continuous alarms by pausing tracking (user must manually stop though)
    clearInterval(appState.trackingIntervalId);
}

// --- SOS Logic ---
function initSOS() {
    elements.shareWhatsappBtn.addEventListener('click', () => shareLocation('whatsapp'));
    elements.shareSmsBtn.addEventListener('click', () => shareLocation('sms'));
}

function shareLocation(platform) {
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            const mapsLink = `https://maps.google.com/?q=${lat},${lon}`;
            const message = encodeURIComponent(`URGENT: I need help. This is my live location: ${mapsLink}`);
            
            if (platform === 'whatsapp') {
                window.open(`https://wa.me/?text=${message}`, '_blank');
            } else if (platform === 'sms') {
                window.open(`sms:?body=${message}`, '_self');
            }
        },
        (error) => {
            alert("Could not detect location for SOS. Ensure GPS is enabled.");
        },
        { enableHighAccuracy: true }
    );
}

// --- Local Transport Logic (Mock based on Location) ---
function initTransport() {
    elements.refreshTransportBtn.addEventListener('click', updateLocalTransport);
}

function updateLocalTransport() {
    elements.transportList.innerHTML = '<p>Searching for local rides...</p>';
    
    navigator.geolocation.getCurrentPosition(
        async (position) => {
            const lat = position.coords.latitude;
            const lon = position.coords.longitude;
            
            // Reverse Geocode
            try {
                const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
                const data = await res.json();
                const city = data.address.city || data.address.town || data.address.state_district || 'your area';
                
                elements.currentLocationText.textContent = `Current Location: ${city}`;
                
                // Generate Mock Indian Transport Providers
                const providers = [
                    { name: 'Local Auto Rickshaw Stand', time: '2 mins away', type: '🛺' },
                    { name: 'Rapido Bike Taxi', time: '5 mins away', type: '🏍️' },
                    { name: 'Ola / Uber Cab', time: '8 mins away', type: '🚕' },
                    { name: 'E-Rickshaw Stand', time: 'Nearby', type: '🛺' }
                ];
                
                elements.transportList.innerHTML = '';
                providers.forEach(p => {
                    const card = document.createElement('div');
                    card.className = 'transport-card';
                    card.innerHTML = `
                        <div>
                            <h3>${p.type} ${p.name}</h3>
                            <p>${p.time}</p>
                        </div>
                        <button class="primary-btn" style="width: auto; margin:0;" onclick="alert('In a full app, this would redirect to ${p.name}')">Book</button>
                    `;
                    elements.transportList.appendChild(card);
                });

            } catch(e) {
                elements.transportList.innerHTML = '<p>Could not fetch transport data.</p>';
            }
        },
        (error) => {
            elements.transportList.innerHTML = '<p>Location required to find transport.</p>';
        }
    );
}

// --- Accessibility Tools ---
function speakFeedback(text) {
    if ('speechSynthesis' in window) {
        const msg = new SpeechSynthesisUtterance(text);
        // Try to pick an English voice
        const voices = window.speechSynthesis.getVoices();
        const enVoice = voices.find(v => v.lang.startsWith('en'));
        if (enVoice) msg.voice = enVoice;
        
        window.speechSynthesis.speak(msg);
    }
}

// --- Utilities (Haversine & Deviation) ---
function calculateDeviation(userLat, userLon, routeCoords) {
    // Find minimum distance from user point to any point on the route
    let minDistance = Infinity;
    for (const point of routeCoords) {
        const pointLon = point[0];
        const pointLat = point[1];
        const dist = haversineDistance(userLat, userLon, pointLat, pointLon);
        if (dist < minDistance) minDistance = dist;
    }
    return minDistance * 1000; // Return in meters
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth default radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// --- Saved Trips Logic ---
function initSavedTrips() {
    const savedTripsSelect = document.getElementById('saved-trips');
    
    // Populate dropdown
    appState.savedTrips.forEach((trip, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `${trip.dest.name} - ${trip.threshold} mins`;
        savedTripsSelect.appendChild(option);
    });
    
    savedTripsSelect.addEventListener('change', (e) => {
        const index = e.target.value;
        if (index === "") return;
        
        const trip = appState.savedTrips[index];
        appState.destination = trip.dest;
        elements.destInput.value = trip.dest.name;
        elements.minThresholdInput.value = trip.threshold;
        speakFeedback(`Loaded saved trip for ${trip.dest.name}`);
    });
}

function saveTrip(dest, threshold) {
    // Check if duplicate
    const exists = appState.savedTrips.some(t => t.dest.name === dest.name && t.threshold === threshold);
    if (!exists) {
        appState.savedTrips.push({ dest, threshold });
        // Keep only last 5
        if(appState.savedTrips.length > 5) appState.savedTrips.shift();
        localStorage.setItem('savedTrips', JSON.stringify(appState.savedTrips));
        
        // Re-init dropdown (lazy way)
        const savedTripsSelect = document.getElementById('saved-trips');
        savedTripsSelect.innerHTML = '<option value="">-- Choose a saved trip --</option>';
        initSavedTrips();
    }
}
