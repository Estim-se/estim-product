import { describe, expect, it } from 'vitest';
import { auditEvent, auditTimeline, companyInitials, realSentStatus } from '@/lib/real-presentation';
import { initialThreads } from '@/data/inbox';

describe('Real company presentation rules',()=>{
  it('uses the real company initials',()=>{expect(companyInitials('farax')).toBe('F');expect(companyInitials('farax el')).toBe('FE');});
  it('shows a delivered WhatsApp text as a reply, not an attached quote',()=>{const t=initialThreads()[0];if(!t)throw new Error('Missing fixture');t.waSent=true;t.msgs=[{from:'vv',text:'Hej',time:'12:00',quote:true}];expect(realSentStatus(t)[0]).toBe('Svar skickat');});
  it('attributes non-approval events to their author',()=>{expect(auditEvent({event:'Förfrågan skapad',actor_name:'Abdikarim',approved_name:''})).toBe('Förfrågan skapad av Abdikarim');expect(auditTimeline({event:'Offert ändrad',actor_name:'Abdikarim',approved_name:''})).toBe('Offert ändrad av Abdikarim');});
  it('reserves approval attribution for approved replies',()=>{expect(auditTimeline({event:'Svar godkänt',actor_name:'Abdikarim',approved_name:'Abdikarim'})).toBe('Svar godkänt · Godkänd av Abdikarim');});
  it('only marks the latest sent reply as a quote when it has an attachment',()=>{const t=initialThreads()[0];if(!t)throw new Error('Missing fixture');t.msgs=[{from:'vv',text:'Old quote',time:'12:00',quote:true},{from:'vv',text:'Reply',time:'12:01',quote:false}];expect(realSentStatus(t)[0]).toBe('Svar skickat');t.msgs.push({from:'vv',text:'Quote',time:'12:02',quote:true});expect(realSentStatus(t)[0]).toBe('Offert skickad');});
});