import { fixtureData } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel, DiffHunk } from './model.js';
import { toParseRequest } from './model.js';
import { parseFileDiff } from './parse.js';

function hunks(model: DiffFileModel): DiffHunk[] {
    return model.content.kind === 'text'
        ? model.content.blocks.filter((block): block is DiffHunk => block.kind === 'hunk')
        : [];
}

function modelOf(path: string, lines: readonly string[]): DiffFileModel {
    return parseFileDiff({
        fileId: 'f1',
        path,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        patch: [...lines, ''].join('\n'),
    });
}

function fixtureHunks(path: string): DiffHunk[] {
    const file = fixtureData('medium').diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`file ${path} not found in medium fixture`);
    }
    return hunks(parseFileDiff(toParseRequest(file)));
}

describe('hunk entity', () => {
    it('comes from the header section when git provides it', () => {
        const hunk = fixtureHunks('services/orders/src/domain/policies/edit-policy.ts')[1];

        expect(hunk?.section).toBe('export class EditPolicy');
        // The section names the enclosing entity but does not say where it starts.
        expect(hunk?.entity).toEqual({ label: 'EditPolicy', range: null });
    });

    it('is found in hunk lines when there is no section', () => {
        const hunk = modelOf('service/order_service.py', [
            '@@ -140,6 +140,8 @@',
            ' class OrderService:',
            '     def apply_edit(self, order):',
            '-        if order.editable:',
            '+        if self.window.is_open(order):',
            '+            self.audit.record(order)',
            '             return order.apply()',
            '         return None',
        ]);

        // The first declaration in the hunk is a class at line 140. The range ends at the end of the hunk.
        expect(hunks(hunk)[0]?.entity).toEqual({
            label: 'OrderService',
            range: { side: 'new', from: 140, to: 145 },
        });
    });

    it('is null in a hunk without declarations and never says "unknown"', () => {
        const model = modelOf('service/order_service.py', [
            '@@ -12,4 +12,4 @@',
            '     total = 0',
            '-    total += item.price',
            '+    total += item.price * item.quantity',
            '     return total',
        ]);

        expect(hunks(model)[0]?.entity).toBeNull();
    });

    it('does not look for declarations in files without a language profile', () => {
        const model = modelOf('scripts/rollout.sh', [
            '@@ -1,3 +1,3 @@',
            ' set -e',
            '-deploy --canary',
            '+deploy --canary --wait',
        ]);

        expect(hunks(model)[0]?.entity).toBeNull();
    });

    it('uses the old side for the range when the hunk has no new side', () => {
        const model = modelOf('service/order_service.py', [
            '@@ -30,3 +29,0 @@',
            '-def legacy_apply(order):',
            '-    return order.apply()',
            '-',
        ]);

        expect(hunks(model)[0]?.entity).toEqual({
            label: 'legacy_apply',
            range: { side: 'old', from: 30, to: 32 },
        });
    });

    it('go: function with a receiver', () => {
        const model = modelOf('cmd/order/service.go', [
            '@@ -8,3 +8,4 @@',
            ' func (s *Service) ApplyEdit(ctx context.Context) error {',
            '-    return s.repo.Save(ctx)',
            '+    s.audit.Record(ctx)',
            '+    return s.repo.Save(ctx)',
        ]);

        expect(hunks(model)[0]?.entity?.label).toBe('ApplyEdit');
    });

    it('ts: distinguishes a class method from a function call', () => {
        const model = modelOf('services/orders/src/domain/edit-window.ts', [
            '@@ -20,3 +20,3 @@',
            '     remainingMs(input: EditWindowInput): number {',
            '-        return 0;',
            '+        return this.closesAt.getTime();',
        ]);
        const called = modelOf('services/orders/src/domain/edit-window.ts', [
            '@@ -20,2 +20,2 @@',
            '     remainingMs(input);',
            '-    log(input);',
            '+    log(input, "ms");',
        ]);

        expect(hunks(model)[0]?.entity?.label).toBe('remainingMs');
        expect(hunks(called)[0]?.entity).toBeNull();
    });

    it('a long section is no longer an entity name and does not fit in the header', () => {
        const model = modelOf('services/orders/.github/CODEOWNERS', [
            `@@ -5,2 +5,2 @@ ${'x'.repeat(120)}`,
            '-  timeout: 30',
            '+  timeout: 60',
        ]);

        expect(hunks(model)[0]?.entity).toBeNull();
    });

    it('a short section without a recognized declaration goes into the header as is', () => {
        const model = modelOf('services/orders/.github/CODEOWNERS', [
            '@@ -5,2 +5,2 @@ ci:',
            '-  timeout: 30',
            '+  timeout: 60',
        ]);

        expect(hunks(model)[0]?.entity).toEqual({ label: 'ci:', range: null });
    });
});
