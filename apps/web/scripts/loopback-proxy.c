#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

static volatile sig_atomic_t running = 1;
static void stop(int signal_number) { (void)signal_number; running = 0; }

static unsigned number(const char *value, unsigned maximum) {
  char *end = NULL;
  unsigned long parsed = strtoul(value, &end, 10);
  if (!*value || *end || !parsed || parsed > maximum) {
    fprintf(stderr, "Invalid proxy configuration\n");
    exit(1);
  }
  return (unsigned)parsed;
}

static struct sockaddr_in address(unsigned port) {
  struct sockaddr_in result = {0};
  result.sin_family = AF_INET;
  result.sin_port = htons((uint16_t)port);
  result.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  return result;
}

static int listener(unsigned port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0), yes = 1;
  struct sockaddr_in local = address(port);
  if (fd < 0) return -1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  if (bind(fd, (struct sockaddr *)&local, sizeof(local)) || listen(fd, 128)) {
    close(fd); return -1;
  }
  return fd;
}

static void redirect_http(int client) {
  char request[8193] = {0}, method[16], path[4097], version[16], response[4608];
  size_t used = 0;
  struct timeval timeout = {5, 0};
  setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  while (used < sizeof(request) - 1 && !strstr(request, "\r\n\r\n")) {
    ssize_t count = recv(client, request + used, sizeof(request) - 1 - used, 0);
    if (count <= 0) return;
    used += (size_t)count;
  }
  if (!strstr(request, "\r\n\r\n") ||
      sscanf(request, "%15s %4096s %15s", method, path, version) != 3 ||
      path[0] != '/' || (strcmp(version, "HTTP/1.1") && strcmp(version, "HTTP/1.0"))) return;
  unsigned hosts = 0;
  int allowed = 0;
  char *line = strstr(request, "\r\n");
  while (line && *(line += 2)) {
    char *end = strstr(line, "\r\n");
    if (!end) break;
    if (!strncasecmp(line, "Host:", 5)) {
      *end = '\0';
      char *host = line + 5;
      while (*host == ' ' || *host == '\t') host++;
      char *port = strchr(host, ':');
      if (port) *port = '\0';
      char *tail = host + strlen(host);
      while (tail > host && (tail[-1] == ' ' || tail[-1] == '\t')) *--tail = '\0';
      hosts++; allowed = !strcasecmp(host, "super.local");
      *end = '\r';
    }
    line = end;
  }
  int length = hosts == 1 && allowed
    ? snprintf(response, sizeof(response), "HTTP/1.1 308 Permanent Redirect\r\nLocation: https://super.local%s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", path)
    : snprintf(response, sizeof(response), "HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  if (length <= 0 || (size_t)length >= sizeof(response)) return;
  for (int sent = 0; sent < length;) {
    ssize_t count = send(client, response + sent, (size_t)(length - sent), 0);
    if (count <= 0) return;
    sent += (int)count;
  }
}

static void forward_tls(int client) {
  int upstream = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in target = address(5178);
  if (upstream < 0) return;
  if (connect(upstream, (struct sockaddr *)&target, sizeof(target))) { close(upstream); return; }
  int fd[2] = {client, upstream}, eof[2] = {0}, shut[2] = {0};
  char buffer[2][32768];
  size_t length[2] = {0};
  for (int i = 0; i < 2; i++) fcntl(fd[i], F_SETFL, fcntl(fd[i], F_GETFL) | O_NONBLOCK);
  while (running && (!eof[0] || !eof[1] || length[0] || length[1])) {
    fd_set reads, writes;
    FD_ZERO(&reads); FD_ZERO(&writes);
    for (int i = 0; i < 2; i++) {
      if (!eof[i] && length[i] < sizeof(buffer[i])) FD_SET(fd[i], &reads);
      if (length[i]) FD_SET(fd[1-i], &writes);
    }
    struct timeval timeout = {300, 0};
    int ready = select((client > upstream ? client : upstream) + 1, &reads, &writes, NULL, &timeout);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) break;
    for (int i = 0; i < 2; i++) {
      if (FD_ISSET(fd[i], &reads)) {
        ssize_t count = recv(fd[i], buffer[i] + length[i], sizeof(buffer[i]) - length[i], 0);
        if (count > 0) length[i] += (size_t)count;
        else if (!count) eof[i] = 1;
        else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) goto done;
      }
      if (length[i] && FD_ISSET(fd[1-i], &writes)) {
        ssize_t count = send(fd[1-i], buffer[i], length[i], 0);
        if (count > 0) { length[i] -= (size_t)count; memmove(buffer[i], buffer[i] + count, length[i]); }
        else if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) goto done;
      }
      if (eof[i] && !length[i] && !shut[i]) { shutdown(fd[1-i], SHUT_WR); shut[i] = 1; }
    }
  }
done:
  close(upstream);
}

int main(int argc, char **argv) {
  if (argc != 3 && argc != 5) { fprintf(stderr, "Usage: loopback-proxy uid gid [http-port https-port]\n"); return 1; }
  uid_t uid = (uid_t)number(argv[1], 2147483647);
  gid_t gid = (gid_t)number(argv[2], 2147483647);
  unsigned ports[2] = {argc == 5 ? number(argv[3], 65535) : 80, argc == 5 ? number(argv[4], 65535) : 443};
  int sockets[2] = {-1, -1};
  signal(SIGPIPE, SIG_IGN); signal(SIGCHLD, SIG_IGN);
  signal(SIGTERM, stop); signal(SIGINT, stop);
  for (int i = 0; i < 2; i++) if ((sockets[i] = listener(ports[i])) < 0) {
    fprintf(stderr, "Cannot bind loopback port %u: %s\n", ports[i], strerror(errno));
    if (sockets[0] >= 0) close(sockets[0]);
    return 1;
  }
  if ((geteuid() == 0 && (setgroups(0, NULL) || setgid(gid) || setuid(uid))) || getuid() != uid || geteuid() != uid || getgid() != gid) {
    fprintf(stderr, "Cannot drop proxy privileges\n"); close(sockets[0]); close(sockets[1]); return 1;
  }
  fprintf(stdout, "Superlocal loopback proxy: HTTP %u, HTTPS %u -> 5178, uid %u\n", ports[0], ports[1], (unsigned)getuid()); fflush(stdout);
  while (running) {
    fd_set reads; FD_ZERO(&reads); FD_SET(sockets[0], &reads); FD_SET(sockets[1], &reads);
    struct timeval timeout = {1, 0};
    if (select((sockets[0] > sockets[1] ? sockets[0] : sockets[1]) + 1, &reads, NULL, NULL, &timeout) <= 0) continue;
    for (int i = 0; i < 2; i++) if (FD_ISSET(sockets[i], &reads)) {
      int client = accept(sockets[i], NULL, NULL);
      if (client < 0) continue;
      pid_t pid = fork();
      if (!pid) { close(sockets[0]); close(sockets[1]); if (i) forward_tls(client); else redirect_http(client); close(client); _exit(0); }
      close(client);
    }
  }
  close(sockets[0]); close(sockets[1]); return 0;
}
