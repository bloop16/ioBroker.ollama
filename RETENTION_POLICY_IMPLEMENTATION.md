# Retention Policy Implementation

## Übersicht

Diese Implementierung ersetzt das zufällige 5%-Cleanup-System durch eine professionelle, konfigurierbare Aufbewahrungsrichtlinie für die Vektordatenbank.

## ✅ Implementierte Features

### 1. Intelligente Retention Policy (QdrantClient)

**Neue Methoden:**
- `QdrantHelper.retentionCleanup(datapointId, qdrantUrl, collectionName, config, log)`
- `QdrantHelper.runRetentionCleanup(enabledDatapoints, qdrantUrl, collectionName, config, log)`

**Cleanup-Kriterien:**
- **Alter**: Einträge älter als `retentionDays` werden gelöscht
- **Anzahl**: Nur die neuesten `retentionMaxEntries` pro Datenpunkt werden behalten
- **Priorisierung**: Neueste Einträge haben immer Vorrang

**Entfernt:**
- Zufälliges 5%-Cleanup aus `processEmbeddingDatapoint()`

### 2. Admin-Konfiguration (Database Sektion)

**Neue Einstellungen:**
```json
{
  "retentionEnabled": true,           // Aktiviert/deaktiviert Retention Policy
  "retentionDays": 30,               // Tage bis zur Löschung (1-365)
  "retentionMaxEntries": 100,        // Max. Einträge pro Datenpunkt (1-1000)
  "retentionCleanupInterval": 24     // Cleanup-Intervall in Stunden (1-168)
}
```

**UI-Features:**
- Conditional Visibility: Felder nur sichtbar wenn Vector DB und Retention aktiviert
- Validierung: Min/Max Werte für alle Felder
- Mehrsprachige Hilfe-Texte

### 3. Advanced Settings Sektion

**Timeout-Konfigurationen:**
```json
{
  "llmRequestTimeout": 1200,         // LLM-Anfragen (30-3600s)
  "embeddingTimeout": 300,           // Embedding-Erzeugung (30-1800s) 
  "ragQueryTimeout": 600,            // RAG-Abfragen (30-1800s)
  "progressMonitorInterval": 30      // Fortschrittsberichte (10-120s)
}
```

### 4. Automatischer Timer-Service (main.js)

**Neue Methoden:**
- `startRetentionCleanupTimer()`: Startet Timer-System 
- `runRetentionCleanup()`: Führt Cleanup für alle Datenpunkte aus

**Timer-Verhalten:**
- Initialer Cleanup nach 5 Minuten (verhindert Startup-Konflikte)
- Regelmäßige Ausführung basierend auf `retentionCleanupInterval`
- Automatisches Cleanup beim Adapter-Shutdown

### 5. Monitoring & Transparenz

**Neuer State: `info.retentionCleanup`**
```json
{
  "lastRun": "2024-01-27T15:30:00.000Z",
  "processed": 15,
  "removed": 42
}
```

**Logging:**
- `[RetentionCleanup]` Info-Level für alle wichtigen Ereignisse
- Detaillierte Berichte: verarbeitete Datenpunkte, gelöschte Einträge
- Error-Handling mit spezifischen Fehlermeldungen

### 6. Internationalisierung

**Neue Übersetzungen (DE/EN):**
- Database-Sektion: Retention Policy Einstellungen
- Advanced Settings: Timeout-Konfigurationen  
- Hilfe-Texte für alle neuen Felder

## 🔧 Technische Details

### Cleanup-Algorithmus
```javascript
// 1. Lade alle Einträge für Datenpunkt
// 2. Sortiere nach Timestamp (neueste zuerst)
// 3. Identifiziere Löschkandidaten:
//    - Index >= retentionMaxEntries (zu viele Einträge)
//    - Timestamp < (now - retentionDays) (zu alt)
// 4. Lösche in einem Batch-Vorgang
```

### Memory Management
- LRU Cache für verarbeitete States bleibt unverändert
- Timer werden beim Shutdown ordnungsgemäß bereinigt
- Keine Memory Leaks durch sauberes Interval-Management

### Fehlerbehandlung
- Graceful Degradation: Fehler bei einzelnen Datenpunkten stoppen nicht den gesamten Cleanup
- Timeout-Schutz für Qdrant-Operationen
- Retry-Logic nicht implementiert (bewusste Entscheidung für Einfachheit)

## 📊 Verbesserungen gegenüber altem System

| Kriterium | Alt (5% Random) | Neu (Retention Policy) |
|-----------|----------------|------------------------|
| **Vorhersagbarkeit** | ❌ Zufällig | ✅ Deterministisch |
| **Konfigurierbarkeit** | ❌ Hardcoded | ✅ Admin-UI |
| **Effizienz** | ❌ Bei jeder Anfrage | ✅ Planbare Intervalle |
| **Datenintegrität** | ❌ Wichtige Daten können verloren gehen | ✅ Neueste Daten geschützt |
| **Monitoring** | ❌ Keine Transparenz | ✅ Vollständige Überwachung |
| **Performance** | ❌ Unvorhersagbare Spitzen | ✅ Gleichmäßige Last |

## 🚀 Aktivierung

1. **Admin-UI**: Database → "Enable Retention Policy" aktivieren
2. **Konfiguration**: Anpassung von Tagen, Max-Einträgen, Intervall
3. **Advanced Settings**: Optional Timeout-Anpassungen
4. **Restart**: Adapter neu starten für Timer-Aktivierung

Das System ist abwärtskompatibel - bei deaktivierter Retention Policy passiert nichts.

## 📈 Monitoring

```bash
# State prüfen
cat /opt/iobroker/iobroker-data/states/ollama.0.info.retentionCleanup

# Logs verfolgen  
tail -f /opt/iobroker/log/iobroker.*.log | grep "RetentionCleanup"
```

---

**Status**: ✅ Vollständig implementiert und getestet
**Kompatibilität**: ✅ Abwärtskompatibel, keine Breaking Changes
**Performance**: ✅ Optimiert für große Datenpunkt-Sets
