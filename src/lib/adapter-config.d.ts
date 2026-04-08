// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			localEnabled: boolean;
			backupPath: string;
			ftpEnabled: boolean;
			ftpHost: string;
			ftpPort: number;
			ftpUser: string;
			ftpPassword: string;
			ftpPath: string;
			ftpSecure: boolean;
			smbEnabled: boolean;
			smbHost: string;
			smbShare: string;
			smbPath: string;
			smbUser: string;
			smbPassword: string;
			smbDomain: string;
			httpEnabled: boolean;
			sftpEnabled: boolean;
			sftpHost: string;
			sftpPort: number;
			sftpUser: string;
			sftpPassword: string;
			sftpPath: string;
			webdavEnabled: boolean;
			webdavUrl: string;
			webdavUser: string;
			webdavPassword: string;
			webdavPath: string;
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
