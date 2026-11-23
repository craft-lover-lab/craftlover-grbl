import { SerialPort, ReadlineParser } from 'serialport';
import type { TransportFactory } from './grbl';

/** List the serial ports Windows knows about. */
export async function listPorts() {
  const ports = await SerialPort.list();
  return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer ?? '', friendlyName: (p as { friendlyName?: string }).friendlyName ?? '' }));
}

/** Real serial-port transport for GrblConnection. */
export const openSerial: TransportFactory = (path, baud, on) =>
  new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate: baud, autoOpen: false });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (raw: string) => on.line(raw));
    port.on('close', () => on.close());
    port.on('error', (err) => on.error(err.message));
    port.open((err) => {
      if (err) return reject(err);
      resolve({
        write: (d) => port.write(typeof d === 'string' ? d : Buffer.from(d)),
        close: () => {
          if (port.isOpen) port.close();
        },
      });
    });
  });
