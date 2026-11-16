import { deflateSync } from 'node:zlib';
import { crc32 } from '../../src/lib/crc.js';

/** Synthetic raster fixture, never a shipped cover or product illustration. */
export function coverImage(red=170,green=56,blue=106,width=3,height=4):Buffer {
  const chunk=(name:string,data:Buffer)=>{
    const type=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));
    return Buffer.concat([size,type,data,crc]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(height*(width*3+1));
  for(let row=0;row<height;row++)for(let column=0;column<width;column++){
    const index=row*(width*3+1)+1+column*3;pixels[index]=red;pixels[index+1]=green;pixels[index+2]=blue;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
