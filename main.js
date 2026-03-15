'use strict';

const utils = require('@iobroker/adapter-core');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

class ScriptRestore extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'script-restore',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	async onReady() {
		this.log.info('Script-Restore Adapter instanziiert und bereit.');
		
		// Temporären Ordner sicherstellen
		this.tempDir = path.join(utils.getAbsoluteDefaultDataDir(), 'script-restore-tmp');
		if (!fs.existsSync(this.tempDir)) {
			this.log.info(`Erstelle temporäres Verzeichnis: ${this.tempDir}`);
			fs.mkdirSync(this.tempDir, { recursive: true });
		}
	}

	/**
	 * Zentraler Nachrichten-Eingang
	 */
	async onMessage(obj) {
		this.log.info(`[DEBUG] Eingehende Nachricht vom Frontend: ${obj.command}`);
		
		if (typeof obj === 'object' && obj.message) {
			switch (obj.command) {
				case 'getLocalBackups':
					await this.handleGetLocalBackups(obj);
					break;
				case 'getScriptsFromBackup':
					await this.handleGetScriptsFromBackup(obj);
					break;
				case 'processUploadedBackup':
					await this.handleProcessUploadedBackup(obj);
					break;
				case 'importScript':
					await this.handleImportScript(obj);
					break;
				default:
					this.log.warn(`[DEBUG] Unbekannter Befehl erhalten: ${obj.command}`);
			}
		}
	}

	async handleGetLocalBackups(obj) {
		const backupPath = this.config.backupPath || '/opt/iobroker/backups';
		this.log.info(`[DEBUG] Suche Backups in Pfad: ${backupPath}`);
		
		try {
			if (!fs.existsSync(backupPath)) {
				this.log.error(`[DEBUG] Backup-Pfad existiert nicht: ${backupPath}`);
				this.sendTo(obj.from, obj.command, { error: `Pfad ${backupPath} nicht gefunden.` }, obj.callback);
				return;
			}

			const files = fs.readdirSync(backupPath);
			const backups = files.filter(f => 
				(f.startsWith('javascripts') || f.startsWith('iobroker')) && 
				(f.endsWith('.tar.gz') || f.endsWith('.gz'))
			).sort().reverse();

			this.log.info(`[DEBUG] ${backups.length} Backups gefunden.`);
			this.sendTo(obj.from, obj.command, { backups }, obj.callback);
		} catch (err) {
			this.log.error(`[DEBUG] Fehler in handleGetLocalBackups: ${err.message}`);
			this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
		}
	}

	async handleGetScriptsFromBackup(obj) {
		const { filename } = obj.message;
		const backupPath = this.config.backupPath || '/opt/iobroker/backups';
		const fullPath = path.join(backupPath, filename);
		
		this.log.info(`[DEBUG] Verarbeite lokales Backup: ${fullPath}`);
		await this.extractAndSendScripts(fullPath, obj);
	}

	async handleProcessUploadedBackup(obj) {
		const { filename, data } = obj.message;
		const uploadPath = path.join(this.tempDir, 'uploaded_' + filename);

		this.log.info(`[DEBUG] Empfange Upload: ${filename} (${data.length} chars Base64)`);

		try {
			const buffer = Buffer.from(data, 'base64');
			fs.writeFileSync(uploadPath, buffer);
			this.log.info(`[DEBUG] Datei temporär gespeichert: ${uploadPath}`);

			await this.extractAndSendScripts(uploadPath, obj);

			if (fs.existsSync(uploadPath)) {
				fs.unlinkSync(uploadPath);
			}
		} catch (err) {
			this.log.error(`[DEBUG] Fehler beim Verarbeiten des Uploads: ${err.message}`);
			this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
		}
	}

	async extractAndSendScripts(archivePath, obj) {
		try {
			this.log.info(`[DEBUG] Starte Extraktion aus ${archivePath}`);
			
			// Temp-Inhalt leeren
			await execAsync(`rm -rf "${this.tempDir}"/*.jsonl "${this.tempDir}"/*.json`);
			
			const extractCmd = `tar -xzf "${archivePath}" -C "${this.tempDir}" --wildcards "*.jsonl" "*.json" 2>/dev/null || true`;
			await execAsync(extractCmd);

			let scripts = [];
			const extractedFiles = fs.readdirSync(this.tempDir).filter(f => f.endsWith('.jsonl') || f.endsWith('.json'));
			
			this.log.info(`[DEBUG] ${extractedFiles.length} JSON-Dateien im Archiv gefunden.`);

			for (const file of extractedFiles) {
				const filePath = path.join(this.tempDir, file);
				const content = fs.readFileSync(filePath, 'utf-8');
				
				if (file.endsWith('.jsonl')) {
					const lines = content.split('\n');
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const item = JSON.parse(line);
							this.processItem(item.id || item._id, item.value || item.doc || item, scripts);
						} catch (e) {}
					}
				} else {
					const data = JSON.parse(content);
					if (data.id && data.value) {
						this.processItem(data.id, data.value, scripts);
					} else {
						for (const [k, v] of Object.entries(data)) {
							this.processItem(k, v, scripts);
						}
					}
				}
			}

			this.log.info(`[DEBUG] Extraktion fertig. ${scripts.length} Skripte erkannt.`);
			this.sendTo(obj.from, obj.command, { scripts }, obj.callback);
		} catch (err) {
			this.log.error(`[DEBUG] Extraktionsfehler: ${err.message}`);
			this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
		}
	}

	processItem(key, val, scriptsList) {
		const keyStr = String(key);
		if (typeof val === 'object' && val !== null && (val.type === 'script' || keyStr.startsWith('script.js.'))) {
			if (['channel', 'device', 'folder', 'meta'].includes(val.type)) return;
			
			const c = val.common;
			if (!c || typeof c !== 'object' || (!c.engineType && !c.source)) return;

			const raw = String(c.engineType || 'JS').toLowerCase();
			const sType = raw.includes('ts') || raw.includes('typescript') ? 'TypeScript' : 
						  raw.includes('blockly') ? 'Blockly' : 
						  raw.includes('rules') ? 'Rules' : 'JS';
			
			const src = c.source || '';
			let name = keyStr.split('.').pop();
			
			if (c.name) {
				if (typeof c.name === 'object') {
					name = c.name.de || c.name.en || Object.values(c.name)[0];
				} else {
					name = c.name;
				}
			}

			const sPath = keyStr.startsWith('script.js.') ? keyStr.substring(10) : keyStr;
			scriptsList.push({ name, path: sPath, type: sType, source: src });
		}
	}

	async handleImportScript(obj) {
		const { path: scriptPath, source, type, name } = obj.message;
		this.log.info(`[DEBUG] Importiere Skript nach: script.js.restored.${scriptPath}`);

		try {
			const targetId = `script.js.restored.${scriptPath}`;
			const engineType = type === 'TypeScript' ? 'TypeScript/ts' :
							   type === 'Blockly' ? 'Blockly' :
							   type === 'Rules' ? 'Rules' : 'Javascript/js';

			await this.setForeignObjectNotExistsAsync(targetId, {
				type: 'script',
				common: {
					name: `${name} (Restored)`,
					engineType: engineType,
					source: source,
					enabled: false,
					engine: 'system.adapter.javascript.0'
				},
				native: {}
			});

			await this.extendForeignObjectAsync(targetId, {
				common: { source: source, enabled: false }
			});

			this.sendTo(obj.from, obj.command, { success: true }, obj.callback);
		} catch (err) {
			this.log.error(`[DEBUG] Importfehler: ${err.message}`);
			this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
		}
	}

	onUnload(callback) {
		try {
			if (fs.existsSync(this.tempDir)) {
				exec(`rm -rf "${this.tempDir}"`);
			}
			callback();
		} catch (e) {
			callback();
		}
	}
}

if (require.main === module) {
	new ScriptRestore();
} else {
	module.exports = (options) => new ScriptRestore(options);
}
