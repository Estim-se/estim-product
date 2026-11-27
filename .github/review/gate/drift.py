"""The drift check (plan §5 plan step 7, sweeper; step 2 F7, F9): the gate's own settings against a baseline.

With a read-only token GitHub shows each ruleset's enforcement, conditions, rules and updated_at, the GraphQL count
of its bypass actors (not who they are), the environments' deployment policies and admin bypass, and CODEOWNERS
errors. updated_at moves on every real ruleset change, bypass actors included, so a deliberate change updates the
baseline in config.json through a reviewed PR. A mismatch never lets a review post success.

Not visible here: classic protection and the bypass actors themselves (monthly manual check), and the App
installation, which the post job and the sweeper check with the App's JWT.
"""
from .common import canonical, sha256_hex

BYPASS_QUERY = '''query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    rulesets(first: 50) { nodes { databaseId name bypassActors(first: 1) { totalCount } } }
  }
}'''


def snapshot(gh, cfg):
    repo = cfg['repository']
    owner, name = repo.split('/')
    out = {'rulesets': {}, 'environments': {}, 'codeowners_errors': 0}
    counts = {}
    data = gh.graphql(BYPASS_QUERY, {'owner': owner, 'name': name})
    for node in data['repository']['rulesets']['nodes']:
        counts[node['databaseId']] = node['bypassActors']['totalCount']
    for summary in gh.get(f'/repos/{repo}/rulesets?per_page=100&includes_parents=true'):
        full = gh.get(f"/repos/{repo}/rulesets/{summary['id']}")
        out['rulesets'][full['name']] = {
            'id': full['id'], 'target': full.get('target'), 'enforcement': full.get('enforcement'),
            'updated_at': full.get('updated_at'), 'source_type': full.get('source_type'),
            'conditions': sha256_hex(canonical(full.get('conditions'))),
            'rules': sha256_hex(canonical(sorted((full.get('rules') or []), key=canonical))),
            'bypass_count': counts.get(full['id']),
        }
    for env_name in ('review', 'post'):
        env = gh.get(f'/repos/{repo}/environments/{env_name}')
        policy = env.get('deployment_branch_policy') or {}
        branches = gh.get(f'/repos/{repo}/environments/{env_name}/deployment-branch-policies?per_page=100')
        out['environments'][env_name] = {
            'can_admins_bypass': env.get('can_admins_bypass'),
            'protected_branches': policy.get('protected_branches'),
            'custom_branch_policies': policy.get('custom_branch_policies'),
            'branches': sorted(f"{b.get('type', 'branch')}:{b['name']}" for b in branches.get('branch_policies', [])),
        }
    errors = gh.get(f"/repos/{repo}/codeowners/errors?ref={cfg['main']}")
    out['codeowners_errors'] = len(errors.get('errors', []))
    return out


def differences(current, baseline):
    """What differs from the baseline, as short public lines (names and fields, no values)."""
    if not baseline:
        return ['config.json has no drift baseline yet']
    diffs = []
    for name in sorted(set(baseline['rulesets']) | set(current['rulesets'])):
        want, got = baseline['rulesets'].get(name), current['rulesets'].get(name)
        if want is None:
            diffs.append(f'ruleset "{name}" is new')
        elif got is None:
            diffs.append(f'ruleset "{name}" is gone')
        else:
            diffs += [f'ruleset "{name}": {k} changed' for k in sorted(want) if want[k] != got.get(k)]
    for name, want in sorted(baseline['environments'].items()):
        got = current['environments'].get(name) or {}
        diffs += [f'environment "{name}": {k} changed' for k in sorted(want) if want[k] != got.get(k)]
    if current['codeowners_errors']:
        diffs.append(f"CODEOWNERS has {current['codeowners_errors']} errors")
    return diffs
