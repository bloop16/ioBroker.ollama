// Stellen Sie sicher, dass 'axios' in den JavaScript-Adapter-Einstellungen hinzugefügt wurde!
const axios = require('axios').default; // .default wird oft für CommonJS-Kompatibilität benötigt

// Konfiguration
const PYTHON_SERVER_URL_BASE = "SERVER_IP"; // Basis-URL des Python-Servers
const PYTHON_EVENT_ENDPOINT = `${PYTHON_SERVER_URL_BASE}/iobroker-event`;
const PYTHON_HEALTH_ENDPOINT = `${PYTHON_SERVER_URL_BASE}/health`;
const HTTP_TIMEOUT = 15000; // Timeout für HTTP-Anfragen in Millisekunden

// NEUE KONFIGURATION: Liste der zu überwachenden Datenpunkte
const TARGET_DATAPOINTS = [
    {
        id: "0_userdata.0.Anwesenheit_Martin", // Eindeutige ID des Datenpunkts
        description: "Anwesenheit von Martin",    // Was repräsentiert dieser Datenpunkt?
        type: "boolean",                          // Datentyp: "boolean", "number", "string", "mixed"
        location: "Zuhause",                      // Ort, falls relevant
        booleanTrueValue: "anwesend",             // Text für true (nur bei type: "boolean")
        booleanFalseValue: "abwesend"             // Text für false (nur bei type: "boolean")
    },
    {
        id: "alias.0.Haus.Wohnzimmer.Temperatur",
        description: "Temperatur im Wohnzimmer",
        type: "number",
        location: "Wohnzimmer",
        unit: "°C"                                // Optionale Einheit für Zahlen
    },
    {
        id: "javascript.0.System.NextGarbageCollection",
        description: "Nächste Müllabfuhr",
        type: "string", // z.B. "Restmüll am 2025-06-15"
        location: "Allgemein"
    },
    {
        id: "hm-rpc.0.MEQ0123456.1.STATE", // Beispiel für einen Rollladenaktor (könnte boolean oder number sein)
        description: "Status Rollladen Wohnzimmer Fenster links",
        type: "boolean", // Annahme: true = offen, false = geschlossen (oder umgekehrt, anpassen!)
        location: "Wohnzimmer",
        booleanTrueValue: "offen",
        booleanFalseValue: "geschlossen"
    },
    {
        id: "sonoff.0.MeinSonoffGeraet.ENERGY_Power",
        description: "Aktueller Stromverbrauch Waschmaschine",
        type: "number",
        location: "Waschkeller",
        unit: "W"
    }
    // Fügen Sie hier weitere Datenpunkte hinzu:
    // {
    //     id: "your.datapoint.id.here",
    //     description: "Eine klare Beschreibung, was dieser Datenpunkt bedeutet.",
    //     type: "string", // oder "number", "boolean", "mixed"
    //     location: "Ort des Geschehens", // Optional
    //     // Für boolean:
    //     // booleanTrueValue: "aktiv",
    //     // booleanFalseValue: "inaktiv",
    //     // Für number:
    //     // unit: "Einheit"
    // }
];

// Hilfsfunktion zum Senden von HTTP-Anfragen mit 'axios'
async function sendHttpRequestWithAxios(url, method, data = null, headers = {}) {
    try {
        const config = {
            method: method,
            url: url,
            timeout: HTTP_TIMEOUT,
            headers: headers
        };

        if (data) {
            config.data = data;
        }
        
        // Wenn Content-Type application/json ist, wird axios Objekte automatisch stringifizieren
        if (headers['Content-Type'] === 'application/json' && typeof data === 'object') {
            // Axios macht das automatisch, aber explizit ist auch ok
        }

        const response = await axios(config);
        // axios gibt bei Erfolg ein Objekt zurück, das 'data' (geparster Body), 'status', 'headers' etc. enthält
        return { 
            statusCode: response.status, 
            body: response.data, // response.data ist der geparste Antwortkörper
            headers: response.headers 
        };
    } catch (error) {
        if (error.response) {
            // Die Anfrage wurde gestellt und der Server antwortete mit einem Statuscode
            // außerhalb des Bereichs von 2xx
            log(`Axios Fehler: Server antwortete mit Status ${error.response.status}. Daten: ${JSON.stringify(error.response.data)}`, 'error');
            // Wir geben ein Objekt zurück, das dem Erfolgsfall ähnelt, um die Behandlung zu vereinheitlichen
            return {
                statusCode: error.response.status,
                body: error.response.data,
                headers: error.response.headers,
                error: true, // Zusätzliches Flag für Fehler
                errorMessage: `Server Error: ${error.response.status}`
            };
        } else if (error.request) {
            // Die Anfrage wurde gestellt, aber keine Antwort erhalten
            // `error.request` ist eine Instanz von XMLHttpRequest im Browser und http.ClientRequest in Node.js
            log(`Axios Fehler: Keine Antwort vom Server erhalten. Request: ${error.request}`, 'error');
            throw new Error(`No response received from server: ${error.message}`); // Werfen Sie den Fehler weiter oder geben Sie ein Fehlerobjekt zurück
        } else {
            // Etwas ist beim Vorbereiten der Anfrage schiefgegangen
            log(`Axios Fehler: Fehler beim Setup der Anfrage. ${error.message}`, 'error');
            throw error; // Werfen Sie den Fehler weiter
        }
    }
}

// Funktion zum Testen der Server-Erreichbarkeit
async function checkPythonServerStatus() {
    log("Teste Erreichbarkeit des Python-Servers (via axios)...");
    try {
        const response = await sendHttpRequestWithAxios(PYTHON_HEALTH_ENDPOINT, 'GET'); 
        
        if (response.statusCode === 200 && !response.error) {
            log(`Python-Server ist erreichbar (via axios). Status: ${response.body.status || 'N/A'}, Nachricht: ${response.body.message || 'N/A'}`);
        } else {
            log(`Python-Server antwortet nicht wie erwartet (via axios). Status: ${response.statusCode}, Antwort: ${JSON.stringify(response.body)}`, 'warn');
        }
    } catch (error) {
        log(`Python-Server NICHT erreichbar unter ${PYTHON_HEALTH_ENDPOINT} (via axios). Fehler: ${error.message || error}`, 'error');
    }
}

// Funktion zum Verarbeiten und Senden von Datenpunktänderungen
async function processAndSendData(datapointConfig, stateObject) {
    log(`Datenpunkt ${datapointConfig.id} (${datapointConfig.description}) hat sich geändert zu: ${stateObject.val} (ts: ${stateObject.ts})`);

    const jsTimestamp = stateObject.ts; // Millisekunden seit Epoche
    const currentValue = stateObject.val;

    const idParts = datapointConfig.id.split('.');
    // device_name kann der letzte Teil der ID sein oder die volle ID für mehr Kontext.
    // Für dieses Beispiel nehmen wir den letzten Teil.
    const device_name = idParts[idParts.length -1]; 

    let event_type_for_payload;

    if (datapointConfig.type === "boolean") {
        event_type_for_payload = currentValue ? (datapointConfig.booleanTrueValue || "aktiv") : (datapointConfig.booleanFalseValue || "inaktiv");
    } else if (datapointConfig.type === "number") {
        event_type_for_payload = `${currentValue}`;
        if (datapointConfig.unit) {
            event_type_for_payload += ` ${datapointConfig.unit}`;
        }
    } else { // string, mixed
        event_type_for_payload = `${currentValue}`;
    }

    const payload = {
        device_name: device_name, // Oder datapointConfig.id für die volle ID
        event_type: event_type_for_payload, // Der aufbereitete Wert oder Zustand
        value: currentValue, // Der Rohwert des Datenpunkts
        data_type: datapointConfig.type, // Der konfigurierte Typ
        human_readable_description: datapointConfig.description, // Die menschliche Beschreibung des Datenpunkts
        timestamp: jsTimestamp, // Zeitstempel der Änderung
        location: datapointConfig.location || "Nicht spezifiziert" // Ort, falls konfiguriert
    };

    log("Sende Daten an Python-Server (via axios): " + JSON.stringify(payload));

    try {
        const headers = { 'Content-Type': 'application/json' };
        const response = await sendHttpRequestWithAxios(PYTHON_EVENT_ENDPOINT, 'POST', payload, headers);
        
        if (response.statusCode >= 200 && response.statusCode < 300 && !response.error) {
            log("Erfolgreich an Python-Server gesendet (via axios). Antwort: " + (typeof response.body === 'string' ? response.body : JSON.stringify(response.body)));
        } else {
            log(`Fehler beim Senden an Python-Server (via axios): Status ${response.statusCode}, Antwort: ${JSON.stringify(response.body)}`, 'error');
        }
    } catch (error) {
        log(`Fehler beim HTTP-Request an ${PYTHON_EVENT_ENDPOINT} (via axios): ${error.message || error}`, 'error');
    }
}

// Subscriptions auf alle konfigurierten Datenpunkte bei Änderung
TARGET_DATAPOINTS.forEach(dpConfig => {
    if (!dpConfig.id || !dpConfig.description || !dpConfig.type) {
        log(`Ungültige Konfiguration für einen Datenpunkt: ${JSON.stringify(dpConfig)}. Überspringe.`, "warn");
        return;
    }
    log(`Registriere Subscription für: ${dpConfig.id} (${dpConfig.description})`);
    on({id: dpConfig.id, change: "ne"}, async function (obj) {
        // obj enthält {id, state, oldState, ack, ts, lc, ...}
        // Wir übergeben die spezifische Konfiguration und das state-Objekt, das den neuen Wert enthält
        await processAndSendData(dpConfig, obj.state);
    });
});

// Skriptstart-Log und Server-Check
log(`ioBroker Skript gestartet (verwendet 'axios' Bibliothek). Überwacht ${TARGET_DATAPOINTS.length} konfigurierte Datenpunkte.`);
checkPythonServerStatus(); // Führe den Server-Check beim Start aus