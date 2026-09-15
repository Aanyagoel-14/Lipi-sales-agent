import { ApprovalDecision } from "@/components/dash/actions";
import { Cell, EmptyState, PageHead, Panel, Row, Table, Tag } from "@/components/dash/ui";
import { getApprovals, timeOf } from "@/lib/dash";

export const metadata = { title: "Approvals · Lipi AI" };

const severityTone = { routine: "neutral", attention: "amber", policy: "magenta" } as const;

export default async function ApprovalsPage() {
  const data = await getApprovals();

  return (
    <>
      <PageHead
        title="Approvals"
        blurb="Nothing here has reached a customer. Each item is an agent action waiting on you."
      />
      {data.approvals.length === 0 ? (
        <EmptyState
          title="Nothing waiting on you"
          body="Agent actions that need a human land here. What reaches this queue depends on your approval policy."
          action={{ href: "/dashboard/train", label: "Review the policy" }}
        />
      ) : (
      <Panel bodyClassName="">
        <Table head={["Agent", "Action", "Detail", "Impact", "Raised", "Severity", ""]}>
          {data.approvals.map((a) => (
            <Row key={a.id}>
              <Cell className="whitespace-nowrap font-medium">{a.agent}</Cell>
              <Cell>{a.summary}</Cell>
              <Cell className="text-ink-muted">{a.detail}</Cell>
              <Cell className="tabular text-ink-muted">{a.impact}</Cell>
              <Cell className="tabular whitespace-nowrap text-ink-subtle">{timeOf(a.raisedIso)}</Cell>
              <Cell>
                <Tag tone={severityTone[a.severity]}>{a.severity}</Tag>
              </Cell>
              <Cell className="text-right">
                <ApprovalDecision id={a.id} />
              </Cell>
            </Row>
          ))}
        </Table>
      </Panel>
      )}
    </>
  );
}
