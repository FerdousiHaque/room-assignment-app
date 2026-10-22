import React from 'react';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProviderManager from '../ProviderManager.jsx';
import RoomManager from '../RoomManager.jsx';

const desks = [{ id: 'd1', name: 'Desk A' }];
const rooms = [{ id: 'r1', deskId: 'd1', code: '10', kind: 'exam' }];
const providers = [{ id: 'p1', firstName: 'Pat', lastName: 'Doe', name: 'Pat Doe', homeDeskId: 'd1', type: 'Doctor' }];
const html = (el) => renderToStaticMarkup(el);

describe('team member view-only vs admin full access', () => {
  it('Providers page: admin sees Add/Edit/Delete, team member (readOnly) sees the list with none of them', () => {
    const admin = html(<ProviderManager providers={providers} desks={desks} rooms={rooms} onChange={() => {}} />);
    const team = html(<ProviderManager providers={providers} desks={desks} rooms={rooms} onChange={() => {}} readOnly />);
    expect(admin).toContain('Add provider');
    expect(admin).toContain('>Edit<');
    expect(admin).toContain('>Delete<');
    expect(team).toContain('Doe, Pat');
    for (const label of ['Add provider', '>Edit<', '>Delete<']) expect(team).not.toContain(label);
  });

  it('Rooms page: admin sees Add/Edit/Delete, team member (readOnly) sees the list with none of them', () => {
    const admin = html(<RoomManager rooms={rooms} desks={desks} onChange={() => {}} />);
    const team = html(<RoomManager rooms={rooms} desks={desks} onChange={() => {}} readOnly />);
    expect(admin).toContain('Add room');
    expect(admin).toContain('>Edit<');
    expect(admin).toContain('>Delete<');
    expect(team).toContain('10');
    for (const label of ['Add room', '>Edit<', '>Delete<']) expect(team).not.toContain(label);
  });
});
