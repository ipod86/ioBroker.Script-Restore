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
		this.log.info('Script-Restore Adapter gestartet.');
		
		// Temporären Ordner für das Entpacken der Backups anlegen
		this.tempDir = path.join(utils.getAbsoluteDefaultDataDir(), 'script-restore-tmp');
		if (!fs.existsSync(this.tempDir)) {
			fs.mkdirSync(this.tempDir, { recursive: true });
		}
	}

	async onMessage(obj) {
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
			}
		}
	}

	async handleGetLocalBackups(obj) {
		const backupPath = this.config.backupPath || '/opt/iobroker/backups';
		try {
			if (!fs.existsSync(backupPath)) {
				this.sendTo(obj.from, obj.command, { error: `Ordner ${backupPath} nicht gefunden.` }, obj.callback);
				return;
			}

			const files = fs.readdirSync(backupPath);
			const backups = files.filter(f => 
				(f.startsWith('javascripts') || f.startsWith('iobroker')) && 
				(f.endsWith('.tar.gz') || f.endsWith('.gz'))
			).sort().reverse();

			this.sendTo(obj.from, obj.command, { backups }, obj.callback);
		} catch (err) {
			this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
		}
	}

	async handleGetScriptsFromBackup(obj) {
		const { filename } = obj.message;
		const backupPath = this.config.backupPath || '/opt/iobroker/backups';
		const fullPath = path.join(backupPath, filename);

		if (!fs.existsSync(fullPath)) {
			this.sendTo(obj.from, obj.command, { error: 'Backup-Datei nicht gefunden.' }, obj.callback);
			return;
		}

		await this.extractAndSendScripts(fullPath, obj);
	}

	async handleProcessUploadedBackup(obj) {
		const { filename, data } = obj.message;
		const uploadPath = path.join(this.tempDir, 'uploaded_' + filename);

		try {
			// Base64 String in echte Datei umwandeln und speichern
			const buffer = Buffer.from(data, 'base64');
			fs.writeFileSync(uploadPath, buffer);

			// Auslesen und ans Frontend senden
			await this.extractAndSendScripts(uploadPath, obj);

			// Nach dem Auslesen die hochgeladene Datei wieder löschen
			if (fs.existsSync(uploadPath)) {
				fs.unlinkSync(uploadPath);
			}
		} catch (err) {
			this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
		}
	}

	async extractAndSendScripts(archivePath, obj) {
		try {
			// Temporären Ordner leeren
			await execAsync(`rm -rf "${this.tempDir}"/*.jsonl "${this.tempDir}"/*.json`);
			
			const extractCmd = `tar -xzf "${archivePath}" -C "${this.tempDir}" --wildcards "*.jsonl" "*.json" 2>/dev/null || true`;
			await execAsync(extractCmd);

			let scripts = [];
			const extractedFiles = fs.readdirSync(this.tempDir).filter(f => f.endsWith('.jsonl') || f.endsWith('.json'));

			for (const file of extractedFiles) {
				const filePath = path.join(this.tempDir, file);
				const parsedScripts = await this.parseBackupFile(filePath);
				scripts = scripts.concat(parsedScripts);
			}

			this.sendTo(obj.from, obj.command, { scripts }, obj.callback);
		} catch (err) {
			this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
		}
	}

	async parseBackupFile(filePath) {
		const scripts = [];
		try {
			const content = fs.readFileSync(filePath, 'utf-8');
			if (filePath.endsWith('.jsonl')) {
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
		} catch (err) {
			this.log.error(`Fehler beim Parsen von ${filePath}: ${err.message}`);
		}
		return scripts;
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
		if (!scriptPath || !source) {
			this.sendTo(obj.from, obj.command, { error: 'Fehlende Skriptdaten für den Import.' }, obj.callback);
			return;
		}

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

			this.sendTo(obj.from, obj.command, { success: true, targetId }, obj.callback);
		} catch (err) {
			this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
		}
	}

	onUnload(callback) {
		try {
			if (fs.existsSync(this.tempDir)) exec(`rm -rf "${this.tempDir}"`);
			callback();
		} catch (e) { callback(); }
	}
}

if (require.main === module) {
	new ScriptRestore();
} else {
	module.exports = (options) => new ScriptRestore(options);
}
