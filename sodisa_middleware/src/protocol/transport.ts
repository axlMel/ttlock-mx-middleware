import { createSocket } from 'node:dgram';

export function sendGeoCommand(host: string, port: number, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');

    try {
      socket.send(command, port, host, (error) => {
        socket.close();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      socket.close();
      reject(error);
    }
  });
}
