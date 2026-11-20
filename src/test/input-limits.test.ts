import { describe, expect, it, vi } from 'vitest';
import { assertBoundedInput, boundedRequest, INPUT_TOO_LARGE, MAX_INPUT_BYTES } from '@/lib/input-limits';
import { mutationSchema, parseMutation, parseSignIn } from '@/lib/real.schemas';

describe('Pre-validation security limits',()=>{
  it('rejects oversized collections before calling Zod',()=>{
    const parse=vi.spyOn(mutationSchema,'parse');
    try { expect(()=>parseMutation({kind:'quote',quote:{lines:Array(201).fill({})}})).toThrow(INPUT_TOO_LARGE);expect(parse).not.toHaveBeenCalled(); }
    finally { parse.mockRestore(); }
  });
  it('rejects oversized text before validation',()=>{expect(()=>parseMutation({kind:'draft',draft:{text:'x'.repeat(30001)}})).toThrow(INPUT_TOO_LARGE);});
  it('rejects deep or cyclic data without recursive validation',()=>{const cycle:Record<string,unknown>={};cycle['child']=cycle;expect(()=>assertBoundedInput(cycle)).toThrow(INPUT_TOO_LARGE);});
  it('rejects aggregate oversized input',()=>{expect(()=>assertBoundedInput(Array(20).fill('x'.repeat(30000)))).toThrow(INPUT_TOO_LARGE);});
  it('accepts valid profile and sign-in form values',()=>{expect(parseMutation({kind:'profile',display_name:'Abdikarim'})).toEqual({kind:'profile',display_name:'Abdikarim'});expect(parseSignIn({email:'user@example.com',display_name:'Abdikarim'}).email).toBe('user@example.com');});
  it('rejects oversized sign-in values',()=>{expect(()=>parseSignIn({email:'x'.repeat(30001),display_name:'A'})).toThrow(INPUT_TOO_LARGE);});
  it('blocks bodies over 256 KiB before framework decoding even without content-length',async()=>{
    const request=new Request('https://app.example.com/',{method:'POST',body:'x'.repeat(MAX_INPUT_BYTES+1)});
    const result=await boundedRequest(request);expect(result).toBeInstanceOf(Response);if(!(result instanceof Response))throw new Error('Expected rejection');expect(result.status).toBe(413);
  });
  it('preserves an ordinary request body exactly',async()=>{const request=new Request('https://app.example.com/',{method:'POST',body:'{"kind":"profile"}'});const result=await boundedRequest(request);expect(result).toBeInstanceOf(Request);expect(await result.text()).toBe('{"kind":"profile"}');});
  it('accepts wrapped dev-server requests without native internal slots',async()=>{
    const original=new Request('https://app.example.com/_serverFn/test',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer test'},body:'{"kind":"profile"}'});
    const wrapped=new Proxy(original,{get(target,key){return typeof key==='symbol'?undefined:Reflect.get(target,key,target);}});
    const result=await boundedRequest(wrapped);
    if(!(result instanceof Request))throw new Error('Expected request');
    expect(result.url).toBe(original.url);
    expect(result.method).toBe('POST');
    expect(result.headers.get('authorization')).toBe('Bearer test');
    expect(await result.text()).toBe('{"kind":"profile"}');
  });
  it('bounds GET input before decoding',async()=>{const result=await boundedRequest(new Request('https://app.example.com/?data='+'x'.repeat(16384)));expect(result).toBeInstanceOf(Response);if(!(result instanceof Response))throw new Error('Expected rejection');expect(result.status).toBe(413);});
});